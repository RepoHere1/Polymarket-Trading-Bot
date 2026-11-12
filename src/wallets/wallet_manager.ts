import { PaperWallet, PaperMarketData } from './paper_wallet';
import { PolymarketWallet, polyUsaClientFactory, type PolymarketClientLike } from './polymarket_wallet';
import { WalletState, WalletConfig, TradeRecord } from '../types';
import { logger } from '../reporting/logs';

import { OrderbookStream } from '../data/orderbook_stream';
import { ClobFetcher } from '../data/clob_fetcher';
import { OrderFill } from '../types';

export interface ExecutionWallet {
  getState(): WalletState;
  getTradeHistory(): TradeRecord[];
  placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<OrderFill | null>;
  updateBalance(delta: number): void;
  /** Optional: set the cash balance to an explicit value (PAPER wallets only). */
  setBalance?(value: number): void;
  /** Optional display name for the dashboard (defaults to walletId) */
  getDisplayName?(): string;
  setDisplayName?(name: string): void;
  /** Update risk limits at runtime */
  updateRiskLimits?(limits: Partial<import('../types').RiskLimits>): void;
}

export class WalletManager {
  private readonly wallets = new Map<string, ExecutionWallet>();
  /** Live market-data sources shared by every PAPER wallet. Set before wallets trade. */
  private marketSources?: PaperMarketData;
  /** LIVE account registry: account walletId → its (closure-cached) client factory. One client per polymarket.us account. */
  private readonly liveFactories = new Map<string, () => PolymarketClientLike | undefined>();
  /** LIVE account walletId → the budget lanes running under it. */
  private readonly liveLanes = new Map<string, { walletId: string; budget: number }[]>();

  /** Inject the live data sources. PAPER wallets read them lazily, so order does not matter. */
  setPaperDependencies(stream: OrderbookStream, clobFetcher: ClobFetcher): void {
    this.marketSources = { stream, clobFetcher };
    logger.info('WalletManager connected PAPER wallets to live CLOB book data');
  }

  private marketData(): PaperMarketData | undefined {
    return this.marketSources;
  }

  /** Build a PAPER wallet wired to the shared live market data (used by the dashboard). */
  createPaperWallet(config: WalletConfig, assignedStrategy: string): PaperWallet {
    return new PaperWallet(config, assignedStrategy, () => this.marketData());
  }

  /**
   * Build a LIVE wallet wired to the shared slug cache (used by the dashboard
   * and registerWallet). Optional imported polyUSA credentials override the
   * environment keys; they live only in the wallet's in-memory client factory.
   * The factory is remembered per account wallet so lanes can share the exact
   * same client (one polymarket.us identity, one connection).
   */
  createLiveWallet(
    config: WalletConfig,
    assignedStrategy: string,
    clientFactory?: () => PolymarketClientLike | undefined,
  ): PolymarketWallet {
    const factory = clientFactory ?? this.envLiveFactory();
    if (factory) {
      this.liveFactories.set(config.id, factory);
    }
    return new PolymarketWallet(config, assignedStrategy, {
      resolveSlug: (marketId) => this.marketData()?.stream.getMarket(marketId)?.slug,
      ...(factory ? { clientFactory: factory } : {}),
    });
  }

  /** Capture the .env credentials once so the account wallet and its lanes share one client. */
  private envLiveFactory(): (() => PolymarketClientLike | undefined) | undefined {
    const keyId = process.env.POLYMARKET_API_KEY;
    const secretKey = process.env.POLYMARKET_API_SECRET;
    if (!keyId || !secretKey) return undefined;
    return polyUsaClientFactory(keyId, secretKey);
  }

  /**
   * Build a budget lane on an existing LIVE account wallet: one polymarket.us
   * account, many strategy lanes. The lane shares the parent's client factory
   * (one identity) and can never spend more than its budget — its reported
   * balance is min(account buying power, budget − spent).
   */
  createLiveLaneWallet(accountWalletId: string, config: WalletConfig, assignedStrategy: string): PolymarketWallet {
    const factory = this.liveFactories.get(accountWalletId);
    if (!factory) {
      throw new Error(`LIVE account wallet "${accountWalletId}" not found — create the LIVE wallet first`);
    }
    if (this.liveLaneParent(accountWalletId)) {
      throw new Error(`"${accountWalletId}" is itself a lane — lanes cannot nest`);
    }
    return new PolymarketWallet(config, assignedStrategy, {
      resolveSlug: (marketId) => this.marketData()?.stream.getMarket(marketId)?.slug,
      clientFactory: factory,
      budgetCap: config.capital,
    });
  }

  /** Record a lane under its parent account wallet (call after addWallet). */
  registerLiveLane(accountWalletId: string, walletId: string, budget: number): void {
    const lanes = this.liveLanes.get(accountWalletId) ?? [];
    lanes.push({ walletId, budget });
    this.liveLanes.set(accountWalletId, lanes);
    logger.info(
      { walletId, accountWalletId, budget },
      `LIVE lane ${walletId} registered under account ${accountWalletId} (budget $${budget})`,
    );
  }

  /** All lanes running under a LIVE account wallet. */
  getLiveLanes(accountWalletId: string): { walletId: string; budget: number }[] {
    return [...(this.liveLanes.get(accountWalletId) ?? [])];
  }

  /** Parent account walletId for a lane, or undefined for standalone wallets. */
  liveLaneParent(walletId: string): string | undefined {
    for (const [parent, lanes] of this.liveLanes) {
      if (lanes.some((l) => l.walletId === walletId)) return parent;
    }
    return undefined;
  }

  /** Real USD buying power of a LIVE account wallet (null when unreadable). */
  async getLiveAccountBalance(accountWalletId: string): Promise<number | null> {
    const wallet = this.wallets.get(accountWalletId);
    if (wallet instanceof PolymarketWallet) return wallet.getExchangeUsdBalance();
    return null;
  }

  registerWallet(config: WalletConfig, assignedStrategy: string, enableLive: boolean): void {
    if (this.wallets.has(config.id)) {
      throw new Error(`Wallet ${config.id} already registered`);
    }

    /* ONE LIVE: config LIVE wallets register on EVERY boot. When the server
       is not armed the wallet still wires (balance reads, previews) - real
       orders are gated inside placeOrder, not here. */
    if (config.mode !== 'PAPER' && !enableLive) {
      logger.info(
        { walletId: config.id },
        'LIVE wallet registered in PREVIEW mode (ENABLE_LIVE_TRADING is not "true": orders stay preview-only until the server is armed)',
      );
    }

    let wallet: ExecutionWallet;
    try {
      wallet =
        config.mode !== 'PAPER'
          ? this.createLiveWallet(config, assignedStrategy)
          : new PaperWallet(config, assignedStrategy, () => this.marketData());
    } catch (err) {
      logger.error(
        { walletId: config.id, err: err instanceof Error ? err.message : String(err) },
        `LIVE wallet ${config.id} could not be wired; skipped`,
      );
      return;
    }

    this.wallets.set(config.id, wallet);
    const state = wallet.getState();
    logger.info(
      { walletId: state.walletId, mode: state.mode, strategy: state.assignedStrategy, capital: state.capitalAllocated },
      `Registered wallet ${state.walletId} (${state.mode}) strategy=${state.assignedStrategy}`,
    );
  }

  getWallet(walletId: string): ExecutionWallet | undefined {
    return this.wallets.get(walletId);
  }

  listWallets(): WalletState[] {
    return Array.from(this.wallets.values()).map((wallet) => wallet.getState());
  }

  getTradeHistory(walletId: string): TradeRecord[] {
    const wallet = this.wallets.get(walletId);
    if (!wallet) return [];
    return wallet.getTradeHistory();
  }

  getAllTradeHistories(): Map<string, TradeRecord[]> {
    const map = new Map<string, TradeRecord[]>();
    for (const [id, wallet] of this.wallets) {
      map.set(id, wallet.getTradeHistory());
    }
    return map;
  }

  removeWallet(walletId: string): boolean {
    if (!this.wallets.has(walletId)) {
      return false;
    }
    const parent = this.liveLaneParent(walletId);
    if (parent) {
      this.liveLanes.set(parent, (this.liveLanes.get(parent) ?? []).filter((l) => l.walletId !== walletId));
    }
    this.liveLanes.delete(walletId);
    this.liveFactories.delete(walletId);
    this.wallets.delete(walletId);
    logger.info({ walletId }, `Wallet ${walletId} removed`);
    return true;
  }

  registerExternalWallet(walletId: string, wallet: ExecutionWallet): void {
    if (this.wallets.has(walletId)) {
      throw new Error(`Wallet ${walletId} already registered`);
    }
    this.wallets.set(walletId, wallet);
  }

  addWallet(wallet: ExecutionWallet): void {
    const state = wallet.getState();
    if (this.wallets.has(state.walletId)) {
      throw new Error(`Wallet ${state.walletId} already registered`);
    }
    this.wallets.set(state.walletId, wallet);
    logger.info(
      { walletId: state.walletId, mode: state.mode, strategy: state.assignedStrategy, capital: state.capitalAllocated },
      `Wallet ${state.walletId} added at runtime (${state.mode}) strategy=${state.assignedStrategy}`,
    );
  }
}
