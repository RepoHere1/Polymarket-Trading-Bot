import { WalletConfig, WalletState, TradeRecord, OrderFill } from '../types';
import { OrderbookStream } from '../data/orderbook_stream';
import { ClobFetcher } from '../data/clob_fetcher';
import { matchAgainstBook, takerFeeUsdc } from '../paper_trading/book_matcher';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

/** Live market-data sources. PAPER fills are matched against these; nothing is simulated. */
export interface PaperMarketData {
  stream: OrderbookStream;
  clobFetcher: ClobFetcher;
}

export type PaperMarketDataProvider = () => PaperMarketData | undefined;

export interface PaperOrderRequest {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

const MAX_TRADES = 1000;

export class PaperWallet {
  private state: WalletState;
  private readonly trades: TradeRecord[] = [];
  private displayName = '';
  private orderSeq = 0;

  constructor(
    config: WalletConfig,
    assignedStrategy: string,
    private readonly marketData: PaperMarketDataProvider = () => undefined,
  ) {
    this.displayName = config.id;
    this.state = {
      walletId: config.id,
      mode: 'PAPER',
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

  updateBalance(delta: number): void {
    this.state.availableBalance += delta;
  }

  getDisplayName(): string {
    return this.displayName;
  }


  /**
   * Fill a PAPER order against the live CLOB book.
   * Returns null when nothing executes (book does not cross, or a SELL with no shares held).
   * Throws when live market data is missing: it never invents a fill.
   */
  async placeOrder(request: PaperOrderRequest): Promise<OrderFill | null> {
    const walletId = this.state.walletId;
    const data = this.marketData();
    if (!data) {
      throw new Error(`PAPER ${walletId}: market data not connected â€” refusing to simulate a fill`);
    }
    const market = data.stream.getMarket(request.marketId);
    if (!market) {
      throw new Error(`PAPER ${walletId}: market ${request.marketId} not in live cache â€” refusing to simulate a fill`);
    }
    const tokenId = request.outcome === 'YES' ? market.clobTokenIds[0] : market.clobTokenIds[1];
    if (!tokenId) {
      throw new Error(`PAPER ${walletId}: no CLOB token for ${request.outcome} on ${request.marketId}`);
    }
    const book = await data.clobFetcher.fetchOrderBook(tokenId);
    if (!book) {
      throw new Error(`PAPER ${walletId}: CLOB book unavailable for ${tokenId} â€” refusing to simulate a fill`);
    }

    const pos = this.state.openPositions.find(
      (p) => p.marketId === request.marketId && p.outcome === request.outcome,
    );
    const held = pos?.size ?? 0;
    // A SELL can only close shares that are actually held. Never mint cash.
    if (request.side === 'SELL' && held <= 0) {
      logger.warn({ walletId, marketId: request.marketId }, 'PAPER SELL rejected: no shares held');
      return null;
    }
    const size = request.side === 'SELL' ? Math.min(request.size, held) : request.size;

    const match = matchAgainstBook(book, { side: request.side, limitPrice: request.price, size });
    if (match.filledSize <= 0) return null;

    const fee = takerFeeUsdc(match.filledSize, match.avgPrice, market.feeRate ?? 0, market.feeExponent ?? 0);
    if (request.side === 'BUY' && match.notional + fee > this.state.availableBalance) {
      logger.warn({ walletId, marketId: request.marketId }, 'PAPER BUY rejected: insufficient balance');
      return null;
    }

    const realized = this.applyFill(request, pos, match.filledSize, match.avgPrice, match.notional, fee);
    const timestamp = Date.now();
    const orderId = `paper-${walletId}-${++this.orderSeq}-${timestamp}`;
    this.recordTrade({
      orderId,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: match.avgPrice,
      size: match.filledSize,
      notional: match.notional,
      fee,
      pnl: realized - fee,
      timestamp,
    });

    consoleLog.success(
      'FILL',
      `[${walletId}] ${request.side} ${request.outcome} Ã—${match.filledSize} @ $${match.avgPrice.toFixed(4)} (fee ${fee.toFixed(5)} USDC) â†’ PnL $${(realized - fee).toFixed(4)} | Bal $${this.state.availableBalance.toFixed(2)}`,
      { walletId, marketId: request.marketId, orderId, unfilled: match.unfilledSize },
    );

    return {
      orderId,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: match.avgPrice,
      size: match.filledSize,
      fee,
      feeAsset: 'USDC',
      timestamp,
    };
  }

  /** Mutates positions and balance. Returns realized gross PnL (before fee). */
  private applyFill(
    request: PaperOrderRequest,
    pos: WalletState['openPositions'][number] | undefined,
    filledSize: number,
    avgPrice: number,
    notional: number,
    fee: number,
  ): number {
    if (request.side === 'BUY') {
      if (pos) {
        const newSize = pos.size + filledSize;
        pos.avgPrice = (pos.avgPrice * pos.size + notional) / newSize;
        pos.size = newSize;
      } else {
        this.state.openPositions.push({
          marketId: request.marketId,
          outcome: request.outcome,
          size: filledSize,
          avgPrice,
          realizedPnl: 0,
        });
      }
      this.state.availableBalance -= notional + fee;
      return 0;
    }

    // SELL: pos is guaranteed to exist and hold shares (checked by caller)
    const realized = (avgPrice - (pos as NonNullable<typeof pos>).avgPrice) * filledSize;
    const held = pos as NonNullable<typeof pos>;
    held.size -= filledSize;
    held.realizedPnl += realized;
    this.state.availableBalance += notional - fee;
    if (held.size <= 1e-9) {
      this.state.openPositions = this.state.openPositions.filter((p) => p !== held);
    }
    return realized;
  }

  private recordTrade(t: {
    orderId: string;
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    notional: number;
    fee: number;
    pnl: number;
    timestamp: number;
  }): void {
    this.state.realizedPnl += t.pnl;
    this.trades.push({
      orderId: t.orderId,
      walletId: this.state.walletId,
      marketId: t.marketId,
      outcome: t.outcome,
      side: t.side,
      price: t.price,
      size: t.size,
      cost: t.notional,
      fee: t.fee,
      feeAsset: 'USDC',
      realizedPnl: t.pnl,
      cumulativePnl: this.state.realizedPnl,
      balanceAfter: this.state.availableBalance,
      timestamp: t.timestamp,
    });
    if (this.trades.length > MAX_TRADES) {
      this.trades.splice(0, this.trades.length - MAX_TRADES);
    }
  }
}
