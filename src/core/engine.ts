import { Scheduler } from './scheduler';
import { OrderbookStream } from '../data/orderbook_stream';
import { ClobFetcher } from '../data/clob_fetcher';
import { WalletManager } from '../wallets/wallet_manager';
import { OrderRouter } from '../execution/order_router';
import { StrategyInterface } from '../strategies/strategy_interface';
import { STRATEGY_REGISTRY } from '../strategies/registry';
import { AppConfig, MarketData, OrderRequest } from '../types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';
import { matchAgainstBook } from '../paper_trading/book_matcher';

interface StrategyRunner {
  strategy: StrategyInterface;
  walletId: string;
  config: Record<string, unknown>;
}

export class Engine {
  private readonly scheduler = new Scheduler();
  private readonly stream: OrderbookStream;
  private readonly clobFetcher: ClobFetcher;
  private readonly runners: StrategyRunner[] = [];
  private readonly pausedWallets = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly walletManager: WalletManager,
    private readonly orderRouter: OrderRouter,
    /** Optional override so tests can inject a stubbed book source */
    clobFetcher?: ClobFetcher,
  ) {
    // Pass Gamma API URL from config to the OrderbookStream
    this.stream = new OrderbookStream(config.polymarket.gammaApi);
    this.clobFetcher = clobFetcher ?? new ClobFetcher(config.polymarket.clobApi);
    this.walletManager.setPaperDependencies(this.stream, this.clobFetcher);
  }

  /**
   * Step B: size orders against real executable depth. A marketable limit
   * order is only as good as the book behind it. We walk the live CLOB book
   * exactly the way the PAPER matcher will: if nothing crosses the limit,
   * the order is dropped up front; if only part of the size is visible,
   * that is flagged and the wallet fills whatever is really there.
   */
  private async checkDepth(order: OrderRequest): Promise<{ filledSize: number; reason?: string }> {
    const market = this.stream.getMarket(order.marketId);
    if (!market) {
      return { filledSize: 0, reason: 'market not in live cache' };
    }
    const tokenId = order.outcome === 'YES' ? market.clobTokenIds[0] : market.clobTokenIds[1];
    if (!tokenId) {
      return { filledSize: 0, reason: `no CLOB token for ${order.outcome}` };
    }
    const book = await this.clobFetcher.fetchOrderBook(tokenId);
    if (!book) {
      return { filledSize: 0, reason: 'order book unavailable' };
    }
    const match = matchAgainstBook(book, { side: order.side, limitPrice: order.price, size: order.size });
    return {
      filledSize: match.filledSize,
      reason: match.filledSize === 0 ? 'no visible depth at limit' : undefined,
    };
  }

  async initialize(): Promise<void> {
    for (const wallet of this.config.wallets) {
      const StrategyCtor = STRATEGY_REGISTRY[wallet.strategy];
      if (!StrategyCtor) {
        logger.warn({ strategy: wallet.strategy }, 'Unknown strategy; skipping');
        consoleLog.warn('ENGINE', `Unknown strategy "${wallet.strategy}" — skipping wallet ${wallet.id}`);
        continue;
      }
      const walletState = this.walletManager.getWallet(wallet.id)?.getState();
      if (!walletState) {
        continue;
      }
      const strategy = new StrategyCtor();
      strategy.initialize({
        wallet: walletState,
        config: this.config.strategyConfig[wallet.strategy] ?? {},
      });
      this.runners.push({
        strategy,
        walletId: wallet.id,
        config: this.config.strategyConfig[wallet.strategy] ?? {},
      });
      consoleLog.info('STRATEGY', `Initialized "${wallet.strategy}" for wallet ${wallet.id}`, {
        walletId: wallet.id,
        strategy: wallet.strategy,
        capital: walletState.capitalAllocated,
        mode: walletState.mode,
      });
    }

    this.stream.on('update', (data) => this.handleMarketUpdate(data));
  }

  start(): void {
    this.stream.start();
    this.scheduler.start(() => this.tick());
    logger.info({ wallets: this.runners.length }, 'Engine started with LIVE Polymarket data');
    consoleLog.success('ENGINE', `Engine started — ${this.runners.length} strategy runners active`, {
      runners: this.runners.length,
      strategies: [...new Set(this.runners.map((r) => r.strategy.name))],
    });
  }

  stop(): void {
    this.scheduler.stop();
    this.stream.stop();
    logger.info('Engine stopped');
    consoleLog.warn('ENGINE', 'Engine stopped');
  }

  /** Expose the stream so the dashboard can query live market data */
  getStream(): OrderbookStream {
    return this.stream;
  }

  /* ━━━━━━━━━━━━━━ Runtime runner management ━━━━━━━━━━━━━━ */

  /**
   * Add a strategy runner for a wallet that was created at runtime
   * (e.g. via the dashboard).  The runner immediately receives all
   * cached market data so the strategy has context for its first tick.
   */
  addRunner(walletId: string, strategyKey: string): boolean {
    // Prevent duplicate runners for the same wallet
    if (this.runners.some((r) => r.walletId === walletId)) {
      logger.warn({ walletId }, 'Runner already exists for wallet');
      return false;
    }

    const StrategyCtor = STRATEGY_REGISTRY[strategyKey];
    if (!StrategyCtor) {
      logger.warn({ walletId, strategy: strategyKey }, 'Unknown strategy; cannot add runner');
      return false;
    }

    const walletState = this.walletManager.getWallet(walletId)?.getState();
    if (!walletState) {
      logger.warn({ walletId }, 'Wallet not found in WalletManager');
      return false;
    }

    const strategy = new StrategyCtor();
    const cfg = this.config.strategyConfig[strategyKey] ?? {};
    strategy.initialize({ wallet: walletState, config: cfg });

    this.runners.push({ strategy, walletId, config: cfg });

    // Back-fill cached market data so the strategy can evaluate immediately
    for (const market of this.stream.getAllMarkets()) {
      strategy.onMarketUpdate(market);
    }

    logger.info(
      { walletId, strategy: strategyKey, cachedMarkets: this.stream.getAllMarkets().length },
      `Runtime runner added for wallet ${walletId} (${strategyKey})`,
    );
    consoleLog.success('WALLET', `Runtime runner added: ${walletId} → ${strategyKey}`, {
      walletId,
      strategy: strategyKey,
      cachedMarkets: this.stream.getAllMarkets().length,
    });
    return true;
  }

  /**
   * Remove the strategy runner for a wallet (e.g. on wallet deletion).
   */
  removeRunner(walletId: string): boolean {
    const idx = this.runners.findIndex((r) => r.walletId === walletId);
    if (idx === -1) return false;

    const runner = this.runners[idx];
    runner.strategy.shutdown();
    this.runners.splice(idx, 1);
    logger.info({ walletId }, `Runtime runner removed for wallet ${walletId}`);
    consoleLog.warn('WALLET', `Runner removed: ${walletId} (${runner.strategy.name})`, {
      walletId,
      strategy: runner.strategy.name,
      remainingRunners: this.runners.length,
    });
    return true;
  }

  /** Number of active strategy runners (for dashboard display). */
  getRunnerCount(): number {
    return this.runners.length;
  }

  /** IDs of wallets that currently have a strategy runner (running OR paused). */
  listRunnerWalletIds(): string[] {
    return this.runners.map((r) => r.walletId);
  }

  /** Get all strategy instances that match a given strategy name (for runtime config). */
  getStrategiesByName(strategyName: string): StrategyInterface[] {
    return this.runners
      .filter((r) => r.config === this.config.strategyConfig[strategyName] || r.strategy.name === strategyName)
      .map((r) => r.strategy);
  }

  /* ━━━━━━━━━━━━━━ Pause / Resume ━━━━━━━━━━━━━━ */

  /**
   * Pause a wallet's strategy runner.  The runner stays in the list
   * (and still receives market updates to stay in-sync) but will not
   * generate signals, size positions, or place orders.
   *
   * OPERATOR LAW: only the operator's dashboard PAUSE button (or restoring
   * the operator's own persisted pause choice at boot) may call this.
   */
  pauseRunner(walletId: string): boolean {
    if (!this.runners.some((r) => r.walletId === walletId)) return false;
    this.pausedWallets.add(walletId);
    consoleLog.warn('ENGINE', `Runner paused: ${walletId}`, { walletId });
    return true;
  }

  /**
   * Resume a previously paused wallet runner.
   *
   * OPERATOR LAW: this runs ONLY from the operator's dashboard START button.
   * The operator's START outranks every software self-stop: the strategy's
   * internal auto-pauses (e.g. copy-trade drawdown breaker, per-whale loss
   * cooldowns) are cleared via onOperatorResume() so the lane actually
   * trades again. No automated path may call this.
   */
  resumeRunner(walletId: string): boolean {
    if (!this.pausedWallets.has(walletId)) return false;
    this.pausedWallets.delete(walletId);
    const runner = this.runners.find((r) => r.walletId === walletId);
    if (typeof runner?.strategy.onOperatorResume === 'function') {
      try {
        runner.strategy.onOperatorResume();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ walletId, err: msg }, 'onOperatorResume hook failed (lane still resumed)');
      }
    }
    consoleLog.success('ENGINE', `Runner resumed by OPERATOR: ${walletId} — software self-stops cleared`, { walletId });
    return true;
  }

  /** Check whether a specific wallet runner is paused. */
  isRunnerPaused(walletId: string): boolean {
    return this.pausedWallets.has(walletId);
  }

  /** Return the set of all currently paused wallet IDs. */
  getPausedWallets(): Set<string> {
    return new Set(this.pausedWallets);
  }

  private tickCount = 0;
  private marketUpdateCount = 0;
  private lastScanLog = 0;
  private lastMarketErrLog = 0;

  private async tick(): Promise<void> {
    this.tickCount++;

    // Log a periodic scan summary every 12 ticks (~60 s at 5 s interval)
    if (this.tickCount % 12 === 0) {
      consoleLog.debug('ENGINE', `Tick #${this.tickCount} — ${this.runners.length} runners, ${this.stream.getAllMarkets().length} cached markets, ${this.marketUpdateCount} updates since last summary`);
      this.marketUpdateCount = 0;
    }

    for (const runner of this.runners) {
      /* OPERATOR LAW: a lane the operator paused never trades. */
      if (this.pausedWallets.has(runner.walletId)) continue;

      /* OPERATOR LAW: a crashing strategy must never take other lanes down
         with it. Before 2026-11-11 one throwing runner aborted the whole
         tick, silently starving every wallet below it in this list — a lane
         "turning off" without the operator's permission. Each runner is now
         isolated: the error is logged and the lane stays attached (only the
         operator may pause or remove it). */
      try {
        runner.strategy.onTimer();
        await this.processSignals(runner);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(
          { walletId: runner.walletId, strategy: runner.strategy.name, err: msg },
          'Strategy runner error isolated — lane stays up per operator law',
        );
        consoleLog.error('ENGINE', `[${runner.strategy.name}] Runner error on ${runner.walletId} isolated — lane stays up (operator law): ${msg}`, {
          walletId: runner.walletId,
          strategy: runner.strategy.name,
        });
      }
    }
  }

  private handleMarketUpdate(data: MarketData): void {
    this.marketUpdateCount++;

    // Throttle per-market update logs to at most once every 30 s
    const now = Date.now();
    if (now - this.lastScanLog > 30_000) {
      consoleLog.debug('SCAN', `Market update: ${data.marketId?.slice(0, 12)}… — ${data.outcomes?.length ?? 0} outcomes`, {
        marketId: data.marketId,
        question: data.question?.slice(0, 80),
      });
      this.lastScanLog = now;
    }

    /* Per-runner isolation (operator law): one bad strategy must not block
       market data for the others. Error log throttled to 1/30 s. */
    for (const runner of this.runners) {
      try {
        runner.strategy.onMarketUpdate(data);
      } catch (err: unknown) {
        const now = Date.now();
        if (now - this.lastMarketErrLog > 30_000) {
          this.lastMarketErrLog = now;
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            { walletId: runner.walletId, strategy: runner.strategy.name, err: msg },
            'onMarketUpdate error isolated — other lanes keep receiving data',
          );
        }
      }
    }
  }

  private async processSignals(runner: StrategyRunner): Promise<void> {
    const signals = await runner.strategy.generateSignals();
    if (signals.length > 0) {
      consoleLog.info('SIGNAL', `[${runner.strategy.name}] Generated ${signals.length} signal(s) for wallet ${runner.walletId}`, {
        walletId: runner.walletId,
        strategy: runner.strategy.name,
        signals: signals.map((s) => ({
          market: s.marketId.slice(0, 12) + '…',
          outcome: s.outcome,
          side: s.side,
          confidence: Number((s.confidence ?? 0).toFixed(3)),
          edge: Number((s.edge ?? 0).toFixed(4)),
        })),
      });
    }

    const orders = await runner.strategy.sizePositions(signals);
    if (orders.length > 0) {
      consoleLog.info('ORDER', `[${runner.strategy.name}] Sized ${orders.length} order(s) for wallet ${runner.walletId}`, {
        walletId: runner.walletId,
        strategy: runner.strategy.name,
        orders: orders.map((o) => ({
          market: o.marketId.slice(0, 12) + '…',
          outcome: o.outcome,
          side: o.side,
          price: o.price,
          size: o.size,
        })),
      });
    }

    for (const order of orders) {
      try {
        /* ── Step B: check executable depth before sending ── */
        const depth = await this.checkDepth(order);
        if (depth.filledSize <= 0) {
          consoleLog.warn('DEPTH', `[${runner.strategy.name}] Dropped ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(4)} — ${depth.reason}`, {
            walletId: order.walletId,
            marketId: order.marketId,
            side: order.side,
            outcome: order.outcome,
            price: order.price,
            size: order.size,
            reason: depth.reason,
          });
          continue;
        }
        if (depth.filledSize < order.size) {
          consoleLog.warn('DEPTH', `[${runner.strategy.name}] Thin book — only ${depth.filledSize}/${order.size} visible at $${order.price.toFixed(4)} for ${order.side} ${order.outcome}`, {
            walletId: order.walletId,
            marketId: order.marketId,
            visible: depth.filledSize,
            requested: order.size,
          });
        }

        /* ── Step A: route and use the REAL fill result ── */
        const fill = await this.orderRouter.route(order);
        if (!fill) {
          consoleLog.warn('ORDER', `[${runner.strategy.name}] No fill — ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(4)} did not cross the book`, {
            walletId: order.walletId,
            marketId: order.marketId,
            side: order.side,
            outcome: order.outcome,
            price: order.price,
            size: order.size,
          });
          continue;
        }

        // Notify the strategy with the ACTUAL fill (average price, filled size) — never the raw request
        const filledOrder: OrderRequest = { ...order, price: fill.price, size: fill.size };
        runner.strategy.notifyFill(filledOrder);
        consoleLog.success('FILL', `[${runner.strategy.name}] Filled ${order.side} ${order.outcome} ×${fill.size} @ $${fill.price.toFixed(4)} (fee $${fill.fee} ${fill.feeAsset})`, {
          walletId: order.walletId,
          strategy: order.strategy,
          marketId: order.marketId,
          outcome: order.outcome,
          side: order.side,
          price: fill.price,
          size: fill.size,
          fee: fill.fee,
          cost: Number((fill.price * fill.size).toFixed(4)),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        consoleLog.error('ORDER', `[${runner.strategy.name}] Order failed: ${msg}`, {
          walletId: order.walletId,
          marketId: order.marketId,
          error: msg,
        });
      }
    }

    await runner.strategy.managePositions();

    /* ── Route exit orders produced by managePositions() ── */
    const exitOrders = runner.strategy.drainExitOrders();
    if (exitOrders.length > 0) {
      consoleLog.info('ORDER', `[${runner.strategy.name}] ${exitOrders.length} exit order(s) for wallet ${runner.walletId}`, {
        walletId: runner.walletId,
        strategy: runner.strategy.name,
        exits: exitOrders.map((o) => ({
          market: o.marketId.slice(0, 12) + '…',
          outcome: o.outcome,
          side: o.side,
          price: o.price,
          size: o.size,
        })),
      });
    }

    for (const exitOrder of exitOrders) {
      try {
        const fill = await this.orderRouter.route(exitOrder);
        if (!fill) {
          consoleLog.warn('ORDER', `[${runner.strategy.name}] Exit not filled — ${exitOrder.side} ${exitOrder.outcome} ×${exitOrder.size} @ $${exitOrder.price.toFixed(4)} did not cross the book`, {
            walletId: exitOrder.walletId,
            marketId: exitOrder.marketId,
            side: exitOrder.side,
            outcome: exitOrder.outcome,
            price: exitOrder.price,
            size: exitOrder.size,
          });
          continue;
        }
        consoleLog.success('FILL', `[${runner.strategy.name}] Exit filled ${exitOrder.outcome} ×${fill.size} @ $${fill.price.toFixed(4)} (fee $${fill.fee} ${fill.feeAsset})`, {
          walletId: exitOrder.walletId,
          strategy: exitOrder.strategy,
          marketId: exitOrder.marketId,
          outcome: exitOrder.outcome,
          side: exitOrder.side,
          price: fill.price,
          size: fill.size,
          fee: fill.fee,
          proceeds: Number((fill.price * fill.size).toFixed(4)),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        consoleLog.error('ORDER', `[${runner.strategy.name}] Exit order failed: ${msg}`, {
          walletId: exitOrder.walletId,
          marketId: exitOrder.marketId,
          error: msg,
        });
      }
    }
  }
}
