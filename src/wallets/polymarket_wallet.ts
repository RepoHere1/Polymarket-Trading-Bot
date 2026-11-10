import {
  PolymarketUS,
  type CreateOrderParams,
  type CreateOrderResponse,
  type GetAccountBalancesResponse,
  type GetMarketResponse,
  type GetUserPositionsParams,
  type GetUserPositionsResponse,
  type PreviewOrderParams,
  type PreviewOrderResponse,
} from 'polymarket-us';
import { WalletConfig, WalletState, TradeRecord, OrderFill } from '../types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

export interface LiveOrderRequest {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

/**
 * Minimal structural slice of the polymarket-us client this wallet uses.
 * Tests inject a stub; production builds the real SDK client.
 */
export interface PolymarketClientLike {
  orders: {
    create(params: CreateOrderParams): Promise<CreateOrderResponse>;
    preview(params: PreviewOrderParams): Promise<PreviewOrderResponse>;
  };
  account: { balances(): Promise<GetAccountBalancesResponse> };
  portfolio: { positions(params?: GetUserPositionsParams): Promise<GetUserPositionsResponse> };
  markets: { retrieveBySlug(slug: string): Promise<GetMarketResponse> };
}

export interface PolymarketWalletDeps {
  /** Client factory. Returns undefined when credentials are missing. */
  clientFactory?: () => PolymarketClientLike | undefined;
  /** Resolves the bot's Gamma marketId to a market slug using the shared live cache. */
  resolveSlug?: (marketId: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const MAX_TRADES = 1000;
const BALANCE_TTL_MS = 10_000;

/** polyUSA quotes prices to 1/10 cent; send a canonical fixed-point string. */
function formatPrice(price: number): string {
  return price.toFixed(3);
}

/**
 * Production client factory: builds the polyUSA SDK client from env
 * credentials. Returns undefined when key/secret are missing so callers
 * fail closed instead of constructing an unauthenticated client.
 */
function defaultClientFactory(): PolymarketClientLike | undefined {
  const keyId = process.env.POLYMARKET_API_KEY;
  const secretKey = process.env.POLYMARKET_API_SECRET;
  if (!keyId || !secretKey) return undefined;
  return new PolymarketUS({ keyId, secretKey });
}

/**
 * LIVE wallet for Polymarket US (api.polymarket.us). Fails closed:
 * 1. Throws unless ENABLE_LIVE_TRADING === 'true'.
 * 2. Throws when POLYMARKET_API_KEY / POLYMARKET_API_SECRET are missing.
 * 3. DRY-RUN IS THE DEFAULT: an order is really placed only when POLYMARKET_DRY_RUN === 'false'.
 *    The dry-run path calls orders.preview() — server-side validation, nothing is placed.
 * 4. Reports a fill only when the exchange response contains executions. No executions → null.
 * 5. Balance is exchange truth (account.balances()). Positions are this wallet's own fills;
 *    the API position object has no clean YES/NO mapping yet (known gap).
 * 6. Trades only markets whose slug exists in the polyUSA catalog (verified, cached).
 */
export class PolymarketWallet {
  private state: WalletState;
  private readonly trades: TradeRecord[] = [];
  private readonly slugCache = new Map<string, string | null>();
  private lastBalanceRefresh = 0;

  constructor(
    config: WalletConfig,
    assignedStrategy: string,
    private readonly deps: PolymarketWalletDeps = {},
  ) {
    this.state = {
      walletId: config.id,
      mode: 'LIVE',
      assignedStrategy,
      capitalAllocated: config.capital,
      availableBalance: config.capital,
      openPositions: [],
      realizedPnl: 0,
      riskLimits: {
        maxPositionSize: config.riskLimits?.maxPositionSize ?? 100,
        maxExposurePerMarket: config.riskLimits?.maxExposurePerMarket ?? 200,
        maxDailyLoss: config.riskLimits?.maxDailyLoss ?? 100,
        maxOpenTrades: config.riskLimits?.maxOpenTrades ?? 5,
        maxDrawdown: config.riskLimits?.maxDrawdown ?? 0.2,
      },
    };
  }

  getState(): WalletState {
    return { ...this.state, openPositions: [...this.state.openPositions] };
  }

  getTradeHistory(): TradeRecord[] {
    return [...this.trades];
  }

  /** LIVE balance is owned by the exchange; runtime nudges are ignored. */
  updateBalance(): void {
    logger.debug({ walletId: this.state.walletId }, 'LIVE wallet balance is exchange-managed; updateBalance ignored');
  }

  /** Live-truth balance with a TTL. Throws on failure when forced pre-trade. */
  async refreshState(force = false): Promise<void> {
    const client = this.client();
    if (!client) return;
    const now = this.deps.now?.() ?? Date.now();
    if (!force && now - this.lastBalanceRefresh < BALANCE_TTL_MS) return;
    try {
      const res = await client.account.balances();
      const usd = res.balances.filter((b) => b.currency === 'USD');
      if (usd.length > 0) {
        this.state.availableBalance = usd.reduce((sum, b) => sum + (b.buyingPower ?? b.currentBalance ?? 0), 0);
        this.lastBalanceRefresh = now;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (force) {
        throw new Error(`LIVE ${this.state.walletId}: account balance unavailable (${msg}) — refusing to trade`);
      }
      logger.warn({ walletId: this.state.walletId, error: msg }, 'LIVE balance refresh failed; keeping last known');
    }
  }

  /** Resolve the bot's Gamma marketId to a polyUSA market slug, or undefined. */
  private async resolveMarketSlug(client: PolymarketClientLike, marketId: string): Promise<string | undefined> {
    const cached = this.slugCache.get(marketId);
    if (cached !== undefined) return cached ?? undefined;
    const gammaSlug = this.deps.resolveSlug?.(marketId);
    if (!gammaSlug) {
      logger.warn({ walletId: this.state.walletId, marketId }, 'LIVE order dropped: market not in live cache');
      this.slugCache.set(marketId, null);
      return undefined;
    }
    try {
      await client.markets.retrieveBySlug(gammaSlug);
      this.slugCache.set(marketId, gammaSlug);
      return gammaSlug;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { walletId: this.state.walletId, marketId, slug: gammaSlug, error: msg },
        'LIVE order dropped: market not tradable on polyUSA (catalog mismatch)',
      );
      this.slugCache.set(marketId, null);
      return undefined;
    }
  }

  private client(): PolymarketClientLike | undefined {
    const factory = this.deps.clientFactory ?? defaultClientFactory;
    return factory();
  }

  /**
   * Map exchange executions to a fill. Honest by construction: executions
   * without shares/px are ignored, and no executions at all → null. Price is
   * the VWAP of what the exchange actually reported; fee is the per-execution
   * commission the exchange collected (0 when it reports none).
   */
  private fillFromExecutions(resp: CreateOrderResponse, request: LiveOrderRequest): OrderFill | null {
    let size = 0;
    let notional = 0;
    let fee = 0;
    for (const e of resp.executions ?? []) {
      const shares = Number(e.lastShares);
      const px = Number(e.lastPx?.value);
      if (!(shares > 0) || !(px > 0)) continue;
      size += shares;
      notional += shares * px;
      fee += Number(e.commissionNotionalCollected?.value ?? 0);
    }
    if (size <= 0) return null;
    return {
      orderId: resp.id,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: notional / size,
      size,
      fee,
      feeAsset: 'USDC',
      timestamp: this.deps.now?.() ?? Date.now(),
    };
  }

  /**
   * Track the fill locally (positions, PnL, trade history). Exchange truth
   * wins on the next refreshState(); this keeps state coherent between
   * refreshes so SELL clamping and dashboards have something real to read.
   */
  private applyLedger(request: LiveOrderRequest, fill: OrderFill): void {
    const notional = fill.price * fill.size;
    const pos = this.state.openPositions.find(
      (p) => p.marketId === request.marketId && p.outcome === request.outcome,
    );

    let realized = 0;
    if (request.side === 'BUY') {
      if (pos) {
        const newSize = pos.size + fill.size;
        pos.avgPrice = (pos.avgPrice * pos.size + notional) / newSize;
        pos.size = newSize;
      } else {
        this.state.openPositions.push({
          marketId: request.marketId,
          outcome: request.outcome,
          size: fill.size,
          avgPrice: fill.price,
          realizedPnl: 0,
        });
      }
      this.state.availableBalance -= notional + fill.fee;
    } else if (pos) {
      realized = (fill.price - pos.avgPrice) * fill.size;
      pos.size -= fill.size;
      pos.realizedPnl += realized;
      this.state.availableBalance += notional - fill.fee;
      if (pos.size <= 1e-9) {
        this.state.openPositions = this.state.openPositions.filter((p) => p !== pos);
      }
    }

    const pnl = realized - fill.fee;
    this.state.realizedPnl += pnl;
    this.trades.push({
      orderId: fill.orderId,
      walletId: this.state.walletId,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: fill.price,
      size: fill.size,
      cost: notional,
      fee: fill.fee,
      feeAsset: fill.feeAsset,
      realizedPnl: pnl,
      cumulativePnl: this.state.realizedPnl,
      balanceAfter: this.state.availableBalance,
      timestamp: fill.timestamp,
    });
    if (this.trades.length > MAX_TRADES) {
      this.trades.splice(0, this.trades.length - MAX_TRADES);
    }
  }

  async placeOrder(request: LiveOrderRequest): Promise<OrderFill | null> {
    const walletId = this.state.walletId;
    const env = this.deps.env ?? process.env;

    if (env.ENABLE_LIVE_TRADING !== 'true') {
      logger.error({ walletId }, 'LIVE order rejected: ENABLE_LIVE_TRADING is not "true" — no order sent');
      throw new Error(`LIVE wallet ${walletId}: ENABLE_LIVE_TRADING is not "true" — refusing to send`);
    }
    const client = this.client();
    if (!client) {
      logger.error({ walletId }, 'LIVE order rejected: POLYMARKET_API_KEY/POLYMARKET_API_SECRET missing');
      throw new Error(`LIVE wallet ${walletId}: polyUSA credentials missing — refusing to send`);
    }

    await this.refreshState(true);

    const slug = await this.resolveMarketSlug(client, request.marketId);
    if (!slug) return null;

    if (!(request.price > 0 && request.price < 1)) {
      logger.warn({ walletId, marketId: request.marketId, price: request.price }, 'LIVE order dropped: price outside (0,1)');
      return null;
    }

    const pos = this.state.openPositions.find(
      (p) => p.marketId === request.marketId && p.outcome === request.outcome,
    );
    let quantity = Math.floor(request.size);
    if (request.side === 'SELL') {
      const held = Math.floor(pos?.size ?? 0);
      if (held <= 0) {
        logger.warn({ walletId, marketId: request.marketId }, 'LIVE SELL rejected: no shares held');
        return null;
      }
      quantity = Math.min(quantity, held);
    }
    if (quantity < 1) {
      logger.warn({ walletId, marketId: request.marketId, size: request.size }, 'LIVE order dropped: size below one share');
      return null;
    }

    const params: CreateOrderParams = {
      marketSlug: slug,
      intent:
        request.side === 'BUY'
          ? request.outcome === 'YES'
            ? 'ORDER_INTENT_BUY_LONG'
            : 'ORDER_INTENT_BUY_SHORT'
          : request.outcome === 'YES'
            ? 'ORDER_INTENT_SELL_LONG'
            : 'ORDER_INTENT_SELL_SHORT',
      type: 'ORDER_TYPE_LIMIT',
      price: { value: formatPrice(request.price), currency: 'USD' },
      quantity,
      tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
      synchronousExecution: true,
    };

    if (env.POLYMARKET_DRY_RUN !== 'false') {
      const preview = await client.orders.preview({ request: params });
      const avg = preview.order.avgPx ? ` avg $${preview.order.avgPx.value}` : '';
      consoleLog.warn(
        'ORDER',
        `[${walletId}] LIVE DRY RUN ${request.side} ${request.outcome} ×${quantity} @ $${request.price.toFixed(3)} → preview ${preview.order.state}${avg} — NOTHING SENT`,
        { walletId, marketId: request.marketId, slug, previewOrderId: preview.order.id },
      );
      return null;
    }

    const resp = await client.orders.create(params);
    const fill = this.fillFromExecutions(resp, request);
    if (!fill) {
      logger.warn(
        { walletId, marketId: request.marketId, orderId: resp.id },
        'LIVE order placed but no executions reported — reporting no fill',
      );
      return null;
    }

    this.applyLedger(request, fill);
    consoleLog.success(
      'FILL',
      `[${walletId}] LIVE ${request.side} ${request.outcome} ×${fill.size} @ $${fill.price.toFixed(4)} (fee ${fill.fee.toFixed(5)} USDC) on ${slug}`,
      { walletId, marketId: request.marketId, slug, orderId: resp.id },
    );
    return fill;
  }
}
