/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Copy Trading Strategy
   ─────────────────────────────────────────────────────────────
   Mirrors trades from configured whale addresses in near-real-
   time, with comprehensive risk management guardrails.

   Features:
   • Multi-whale following — track multiple addresses at once
   • Configurable copy modes: mirror (same direction) or inverse
   • Three sizing modes: fixed, proportional, half-Kelly
   • Full exit management: TP / SL / trailing stop / time exit
   • Per-whale & aggregate drawdown circuit breakers
   • Daily volume / exposure caps
   • Market blacklist / whitelist
   • Cooldown after consecutive losses
   • Whale health monitoring (auto-pause on poor performance)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, OrderRequest, OrderOutcome, OrderSide } from '../../types';
import { logger } from '../../reporting/logs';
import { consoleLog } from '../../reporting/console_log';
import { fetchV2TradesPage, type LegacyDataApiTrade } from '../../data/polymarket_data_api';

/* ━━━━━━━━━━━━━━ Configuration Interface ━━━━━━━━━━━━━━ */

export interface CopyTradeConfig {
  /** Whale addresses to follow */
  whale_addresses: string[];

  /** 'mirror' = same direction as whale, 'inverse' = opposite */
  copy_mode: 'mirror' | 'inverse';

  /** Data API URL for fetching whale trades */
  data_api_url: string;
  /** Gamma API URL for on-demand market metadata (whale markets may be
   *  outside the engine's broadcast set — sizing needs real quotes) */
  gamma_api_url: string;

  /* ── Polling ── */
  /** How often to poll for new whale trades (seconds) */
  poll_interval_seconds: number;
  /** Max whales polled per tick — a rotating window covers the rest on
   *  later ticks. Keeps each tick inside the shared data-API budget
   *  (src/data/polymarket_data_api.ts). <=0 = poll everything each tick. */
  max_polls_per_tick: number;
  /** Max age of a whale trade to still copy (seconds) — must exceed the
   *  worst-case rotation time of the whale universe, or throttled sweeps
   *  silently discard every fill as stale. */
  max_trade_age_seconds: number;

  /* ── Whale Filters ── */
  /** Minimum notional (USD) of a whale trade to copy */
  min_trade_size_usd: number;
  /** Maximum notional (USD) of a whale trade to copy (skip outsized bets) */
  max_trade_size_usd: number;
  /** Minimum whale win rate to follow (0-1) */
  min_whale_win_rate: number;

  /* ── Position Sizing ── */
  /** Sizing mode: 'fixed' | 'proportional' | 'kelly' */
  size_mode: 'fixed' | 'proportional' | 'kelly';
  /** Fixed USD NOTIONAL per trade when size_mode = 'fixed' (shares are
   *  derived from the live price — this is dollars, not share count). */
  fixed_size: number;
  /** Fraction of whale's size when size_mode = 'proportional' (0-1) */
  proportional_factor: number;
  /** Max fraction of wallet capital per single trade. Keep this sane for
   *  SMALL lanes: at 0.05 a $5 lane can only risk $0.25 per trade — not
   *  even one share at most prices, so nothing can ever copy. */
  max_capital_per_trade_pct: number;
  /** Max shares per single order */
  max_shares_per_order: number;

  /* ── Risk / Exposure Limits ── */
  /** Max simultaneous open positions */
  max_open_positions: number;
  /** Max USD exposure per market */
  max_exposure_per_market_usd: number;
  /** Max total daily copy volume (USD) */
  max_daily_volume_usd: number;
  /** Max cumulative drawdown before pausing all copy-trading (0-1) */
  max_drawdown_pct: number;
  /** Max consecutive losses before entering cooldown */
  max_consecutive_losses: number;
  /** Cooldown after hitting max consecutive losses (seconds) */
  cooldown_after_loss_seconds: number;

  /* ── Exit Parameters ── */
  /** Take profit (basis points) */
  take_profit_bps: number;
  /** Stop loss (basis points) */
  stop_loss_bps: number;
  /** Trailing stop activates at this PnL (bps) */
  trailing_stop_activate_bps: number;
  /** Trailing stop deduction from peak (bps) */
  trailing_stop_distance_bps: number;
  /** Time-based exit (minutes) — 0 to disable */
  time_exit_minutes: number;
  /** Close when whale exits (mirror their sell) */
  exit_on_whale_exit: boolean;

  /* ── Filters ── */
  /** Markets to never trade (condition IDs) */
  blacklist_markets: string[];
  /** If non-empty, ONLY trade these markets */
  whitelist_markets: string[];
  /** Min market liquidity to copy into */
  min_market_liquidity: number;
  /** Min market 24h volume */
  min_market_volume_24h: number;
}

export const DEFAULT_COPY_TRADE_CONFIG: CopyTradeConfig = {
  whale_addresses: [],
  copy_mode: 'mirror',
  data_api_url: 'https://data-api.polymarket.com',
  gamma_api_url: 'https://gamma-api.polymarket.com',
  poll_interval_seconds: 30,
  max_polls_per_tick: 25,
  max_trade_age_seconds: 600,
  min_trade_size_usd: 50,
  max_trade_size_usd: 100_000,
  min_whale_win_rate: 0.50,
  size_mode: 'fixed',
  fixed_size: 10,
  proportional_factor: 0.10,
  max_capital_per_trade_pct: 0.20,
  max_shares_per_order: 50,
  max_open_positions: 15,
  max_exposure_per_market_usd: 500,
  max_daily_volume_usd: 5_000,
  max_drawdown_pct: 0.15,
  max_consecutive_losses: 5,
  cooldown_after_loss_seconds: 300,
  take_profit_bps: 150,
  stop_loss_bps: 100,
  trailing_stop_activate_bps: 80,
  trailing_stop_distance_bps: 30,
  time_exit_minutes: 120,
  exit_on_whale_exit: true,
  blacklist_markets: [],
  whitelist_markets: [],
  min_market_liquidity: 500,
  min_market_volume_24h: 1_000,
};

/* ━━━━━━━━━━━━━━ Internal Types ━━━━━━━━━━━━━━ */

/* Raw trades arrive as LegacyDataApiTrade from the v2 Data API client
   (src/data/polymarket_data_api.ts) — the legacy v1 surface is retired. */

/** A whale trade after normalisation */
interface NormalisedWhaleTrade {
  id: string;
  whaleAddress: string;
  marketId: string;
  outcome: OrderOutcome;
  side: OrderSide;
  price: number;
  size: number;
  notionalUsd: number;
  timestamp: number;
}

/** Tracked copy position */
interface CopyPosition {
  marketId: string;
  outcome: OrderOutcome;
  side: OrderSide;
  entryPrice: number;
  entryTime: number;
  size: number;
  peakPnlBps: number;
  whaleAddress: string;
  /** Whether the whale has already exited this market */
  whaleExited: boolean;
}

/** Per-whale performance tracking */
interface WhalePerformance {
  address: string;
  tradesCopied: number;
  wins: number;
  losses: number;
  totalPnlBps: number;
  consecutiveLosses: number;
  pausedUntil: number;
  dailyVolumeUsd: number;
  dailyVolumeResetAt: number;
}

/* ━━━━━━━━━━━━━━ Strategy Implementation ━━━━━━━━━━━━━━ */

export class CopyTradeStrategy extends BaseStrategy {
  readonly name = 'copy_trade';

  private cfg!: CopyTradeConfig;

  /* ── State ── */
  private seenTradeIds = new Set<string>();
  private pendingSignals: Signal[] = [];
  private pendingWhaleTrades: NormalisedWhaleTrade[] = [];
  private positions = new Map<string, CopyPosition>();
  private whalePerf = new Map<string, WhalePerformance>();
  /** Maps marketId → whale address, populated in sizePositions for notifyFill lookup */
  private recentWhaleMap = new Map<string, string>();
  private lastPollAt = 0;
  /** Rotating poll cursor — index into whale_addresses where the next
   *  tick's window starts (keeps per-tick bursts inside the API budget). */
  private pollCursor = 0;
  /** Markets currently being fetched from gamma (dedupe in-flight). */
  private marketFetchInFlight = new Set<string>();
  private totalDailyVolumeUsd = 0;
  private dailyVolumeResetAt = 0;
  private cumulativePnlBps = 0;
  private peakPnlBps = 0;
  private drawdownPaused = false;
  private scanCount = 0;

  protected override cooldownMs = 30_000;

  /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */

  override initialize(context: StrategyContext): void {
    super.initialize(context);
    this.cfg = this.buildConfig(context.config);

    // Initialise per-whale performance trackers
    for (const addr of this.cfg.whale_addresses) {
      this.whalePerf.set(addr.toLowerCase(), {
        address: addr.toLowerCase(),
        tradesCopied: 0,
        wins: 0,
        losses: 0,
        totalPnlBps: 0,
        consecutiveLosses: 0,
        pausedUntil: 0,
        dailyVolumeUsd: 0,
        dailyVolumeResetAt: this.nextDayReset(),
      });
    }

    logger.info({
      strategy: this.name,
      whaleCount: this.cfg.whale_addresses.length,
      copyMode: this.cfg.copy_mode,
      sizeMode: this.cfg.size_mode,
    }, 'Copy Trade strategy initialised');
    consoleLog.info('STRATEGY', `[copy_trade] Following ${this.cfg.whale_addresses.length} whale(s) in ${this.cfg.copy_mode} mode`);
    if (this.cfg.whale_addresses.length > this.pollCap()) {
      consoleLog.info('STRATEGY', `[copy_trade] Rotating poll window: ${this.pollCap()} of ${this.cfg.whale_addresses.length} whales per tick (shared data-API budget)`);
    }
  }

  /** Whales polled per tick — the rotating window size. */
  private pollCap(): number {
    const n = this.cfg.whale_addresses.length;
    if (this.cfg.max_polls_per_tick <= 0 || this.cfg.max_polls_per_tick >= n) return n;
    return this.cfg.max_polls_per_tick;
  }

  /* ━━━━━━━━━━━━━━ Timer — Poll for whale trades ━━━━━━━━━━━━━━ */

  override async onTimer(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPollAt < this.cfg.poll_interval_seconds * 1000) return;
    this.lastPollAt = now;

    // Reset daily volume at midnight UTC
    this.resetDailyIfNeeded(now);

    // Check drawdown circuit breaker
    if (this.drawdownPaused) {
      consoleLog.warn('STRATEGY', '[copy_trade] Paused — drawdown limit reached');
      return;
    }

    // Poll whales in rotating windows so one tick never bursts the shared
    // data-API budget (the 2026-11-12 429 storm blinded every lane).
    const universe = this.cfg.whale_addresses;
    const cap = this.pollCap();
    let polled = 0;

    for (let i = 0; i < universe.length && polled < cap; i++) {
      const address = universe[(this.pollCursor + i) % universe.length];
      const perf = this.whalePerf.get(address.toLowerCase());
      if (perf && now < perf.pausedUntil) {
        continue; // whale-specific cooldown — no request, no budget slot
      }
      polled++; // this whale costs one data-API request, success or failure

      try {
        const trades = await this.fetchWhaleTrades(address);
        const newTrades = trades.filter((t) => !this.seenTradeIds.has(t.id));

        for (const trade of newTrades) {
          this.seenTradeIds.add(trade.id);

          // Apply filters
          if (!this.passesFilters(trade, now)) continue;

          // Convert to signal
          const signal = this.tradeToSignal(trade);
          if (signal) {
            this.pendingSignals.push(signal);
            this.pendingWhaleTrades.push(trade);
            /* Whale markets can be outside the engine's broadcast set —
               pull REAL gamma metadata on demand so sizing can proceed
               (cached; no data → no trade, never fabricated). */
            void this.ensureMarketData(trade.marketId);
          }
        }

        // Check for whale exits (to trigger exit_on_whale_exit)
        if (this.cfg.exit_on_whale_exit) {
          this.detectWhaleExits(trades, address);
        }
      } catch (err) {
        logger.warn({ err, address }, '[copy_trade] Failed to poll whale trades');
      }
    }

    /* Resume after the last whale actually polled; skipped (paused) whales
       are picked up again on the next full rotation. */
    this.pollCursor = (this.pollCursor + polled) % Math.max(1, universe.length);

    // Prune old seen-trade IDs (keep last 10,000)
    if (this.seenTradeIds.size > 10_000) {
      const arr = Array.from(this.seenTradeIds);
      this.seenTradeIds = new Set(arr.slice(-5_000));
    }
  }

  /* ━━━━━━━━━━━━━━ Signal Generation ━━━━━━━━━━━━━━ */

  generateSignals(): Signal[] {
    this.scanCount++;
    const signals = [...this.pendingSignals];
    this.pendingSignals = [];

    if (this.scanCount % 12 === 0) {
      consoleLog.info('STRATEGY', `[copy_trade] Tick #${this.scanCount}: ${this.positions.size} open, ${signals.length} pending signals, drawdown=${(this.getCurrentDrawdownPct() * 100).toFixed(1)}%`, {
        openPositions: this.positions.size,
        pendingSignals: signals.length,
        totalCopied: this.getTotalTradesCopied(),
        cumulativePnlBps: this.cumulativePnlBps,
      });
    }

    return signals;
  }

  /* ━━━━━━━━━━━━━━ Position Sizing ━━━━━━━━━━━━━━ */

  override sizePositions(signals: Signal[]): OrderRequest[] {
    const available = this.context?.wallet.availableBalance ?? 0;
    const initial = this.context?.wallet.capitalAllocated ?? 0;
    const walletId = this.context?.wallet.walletId ?? 'unknown';

    // Don't trade if less than 5% capital remains
    if (available < initial * 0.05) return [];

    // Position limit
    const slotsAvailable = Math.max(0, this.cfg.max_open_positions - this.positions.size);
    if (slotsAvailable === 0) return [];

    // Daily volume cap
    if (this.totalDailyVolumeUsd >= this.cfg.max_daily_volume_usd) return [];

    const orders: OrderRequest[] = [];
    const whaleTrades = [...this.pendingWhaleTrades];
    this.pendingWhaleTrades = [];

    // Populate recentWhaleMap so notifyFill can look up the whale address
    for (const wt of whaleTrades) {
      this.recentWhaleMap.set(wt.marketId, wt.whaleAddress);
    }

    for (let i = 0; i < signals.length && orders.length < slotsAvailable; i++) {
      const signal = signals[i];
      const whaleTrade = whaleTrades[i];

      // Already positioned in this market?
      if (this.positions.has(signal.marketId)) continue;

      const market = this.markets.get(signal.marketId);
      if (!market) continue;

      // Market liquidity / volume filters
      if (market.liquidity < this.cfg.min_market_liquidity) continue;
      if (market.volume24h < this.cfg.min_market_volume_24h) continue;

      // Per-market exposure check
      const existingExposure = this.getMarketExposure(signal.marketId);
      if (existingExposure >= this.cfg.max_exposure_per_market_usd) continue;

      // Determine outcome price
      const outcomePrice = signal.outcome === 'YES'
        ? market.outcomePrices[0]
        : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);
      const safePrice = Number(Math.max(0.02, Math.min(0.98, outcomePrice)).toFixed(4));

      // Calculate size based on mode
      const size = this.calculateSize(signal, whaleTrade, safePrice, available);
      if (size < 1) continue;

      const cost = size * safePrice;

      // Daily volume cap
      if (this.totalDailyVolumeUsd + cost > this.cfg.max_daily_volume_usd) continue;
      if (cost > available) continue;

      this.totalDailyVolumeUsd += cost;

      orders.push({
        walletId,
        marketId: signal.marketId,
        outcome: signal.outcome,
        side: signal.side,
        price: safePrice,
        size,
        strategy: this.name,
      });

      logger.info({
        strategy: this.name,
        whale: whaleTrade?.whaleAddress?.slice(0, 10) ?? 'unknown',
        marketId: signal.marketId,
        outcome: signal.outcome,
        side: signal.side,
        size,
        price: safePrice,
        whaleSize: whaleTrade?.size ?? 0,
        whalePrice: whaleTrade?.price ?? 0,
      }, `COPY_TRADE: mirroring whale trade`);
    }

    return orders;
  }

  /* ━━━━━━━━━━━━━━ Fill Tracking ━━━━━━━━━━━━━━ */

  override notifyFill(order: OrderRequest): void {
    if (order.side !== 'BUY') return;

    // Find the whale address from the pending data
    const whaleAddr = this.findWhaleForMarket(order.marketId) ?? 'unknown';

    this.positions.set(order.marketId, {
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      entryPrice: order.price,
      entryTime: Date.now(),
      size: order.size,
      peakPnlBps: 0,
      whaleAddress: whaleAddr,
      whaleExited: false,
    });

    // Update whale performance
    const perf = this.whalePerf.get(whaleAddr.toLowerCase());
    if (perf) {
      perf.tradesCopied++;
      perf.dailyVolumeUsd += order.price * order.size;
    }

    consoleLog.success('STRATEGY', `[copy_trade] Copied whale ${whaleAddr.slice(0, 10)}… → ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(4)} in market ${order.marketId.slice(0, 12)}…`);
  }

  /* ━━━━━━━━━━━━━━ Position Management — Exits ━━━━━━━━━━━━━━ */

  override managePositions(): void {
    const now = Date.now();

    for (const [marketId, pos] of this.positions) {
      const market = this.markets.get(marketId);
      if (!market) continue;

      // Current price for the position's outcome
      const currentPrice = pos.outcome === 'YES'
        ? market.outcomePrices[0]
        : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);

      // PnL in basis points
      const pnlBps = ((currentPrice - pos.entryPrice) / Math.max(pos.entryPrice, 0.001)) * 10_000;
      const holdMin = (now - pos.entryTime) / 60_000;

      // Track peak for trailing stop
      if (pnlBps > pos.peakPnlBps) pos.peakPnlBps = pnlBps;

      let exitReason: string | undefined;

      // 1. Take profit
      if (pnlBps >= this.cfg.take_profit_bps) {
        exitReason = `TP: +${pnlBps.toFixed(0)}bps`;
      }
      // 2. Stop loss
      else if (pnlBps <= -this.cfg.stop_loss_bps) {
        exitReason = `SL: ${pnlBps.toFixed(0)}bps`;
      }
      // 3. Trailing stop
      else if (
        pos.peakPnlBps >= this.cfg.trailing_stop_activate_bps &&
        pnlBps < pos.peakPnlBps - this.cfg.trailing_stop_distance_bps
      ) {
        exitReason = `TRAIL: peak +${pos.peakPnlBps.toFixed(0)}, now ${pnlBps.toFixed(0)}bps`;
      }
      // 4. Time exit
      else if (this.cfg.time_exit_minutes > 0 && holdMin >= this.cfg.time_exit_minutes) {
        exitReason = `TIME: ${holdMin.toFixed(0)}min`;
      }
      // 5. Whale exited
      else if (this.cfg.exit_on_whale_exit && pos.whaleExited) {
        exitReason = `WHALE_EXIT: whale ${pos.whaleAddress.slice(0, 10)}… closed position`;
      }

      if (exitReason) {
        this.pendingExits.push({
          walletId: this.context?.wallet.walletId ?? 'unknown',
          marketId,
          outcome: pos.outcome,
          side: 'SELL',
          price: currentPrice,
          size: pos.size,
          strategy: this.name,
        });

        // Track win/loss for the whale
        this.recordTradeResult(pos.whaleAddress, pnlBps);
        this.positions.delete(marketId);

        logger.info({
          strategy: this.name,
          marketId,
          outcome: pos.outcome,
          reason: exitReason,
          pnlBps: pnlBps.toFixed(0),
          whale: pos.whaleAddress.slice(0, 10),
        }, `COPY_TRADE exit: ${exitReason}`);
        consoleLog.info('STRATEGY', `[copy_trade] Exit ${marketId.slice(0, 12)}… — ${exitReason}`);
      }
    }
  }

  /* ━━━━━━━━━━━━━━ Data API Polling ━━━━━━━━━━━━━━ */

  /** Fetch recent trades for a whale address from the Polymarket Data API v2
   *  (public, no auth — the legacy v1 /trades surface is 410-gone and the
   *  CLOB /trades endpoint requires L2 auth). */
  private async fetchWhaleTrades(address: string): Promise<NormalisedWhaleTrade[]> {
    try {
      const page = await fetchV2TradesPage(this.cfg.data_api_url, {
        user: address.toLowerCase(),
        limit: 50,
      });

      return page.trades
        .filter((t) => t.proxyWallet && t.side && t.size > 0 && t.price > 0)
        .map((t) => this.normaliseTrade(t, address));
    } catch (err) {
      logger.debug({ address, err: (err as Error).message }, '[copy_trade] v2 trades fetch failed');
      return [];
    }
  }

  private normaliseTrade(raw: LegacyDataApiTrade, whaleAddress: string): NormalisedWhaleTrade {
    const price = raw.price;
    const size = raw.size;
    const side = (raw.side === 'SELL' ? 'SELL' : 'BUY') as OrderSide;
    const outcome = (raw.outcome.toUpperCase() === 'NO' ? 'NO' : 'YES') as OrderOutcome;
    const timestamp = raw.timestamp ? raw.timestamp * 1000 : Date.now();

    return {
      id: raw.transactionHash || `${whaleAddress}-${timestamp}-${raw.asset}`,
      whaleAddress: whaleAddress.toLowerCase(),
      marketId: raw.conditionId || raw.asset,
      outcome,
      side,
      price,
      size,
      notionalUsd: price * size,
      timestamp,
    };
  }

  /* ━━━━━━━━━━━━━━ Filters ━━━━━━━━━━━━━━ */

  private passesFilters(trade: NormalisedWhaleTrade, now: number): boolean {
    // Age filter
    const ageSeconds = (now - trade.timestamp) / 1000;
    if (ageSeconds > this.cfg.max_trade_age_seconds) return false;

    // Notional size filters
    if (trade.notionalUsd < this.cfg.min_trade_size_usd) return false;
    if (trade.notionalUsd > this.cfg.max_trade_size_usd) return false;

    // Market blacklist / whitelist
    if (this.cfg.blacklist_markets.includes(trade.marketId)) return false;
    if (this.cfg.whitelist_markets.length > 0 && !this.cfg.whitelist_markets.includes(trade.marketId)) return false;

    // Already have a position in this market
    if (this.positions.has(trade.marketId)) return false;

    // Drawdown breaker
    if (this.getCurrentDrawdownPct() >= this.cfg.max_drawdown_pct) {
      this.drawdownPaused = true;
      return false;
    }

    return true;
  }

  /* ━━━━━━━━━━━━━━ Signal Conversion ━━━━━━━━━━━━━━ */

  private tradeToSignal(trade: NormalisedWhaleTrade): Signal | null {
    // Only copy BUY trades from whales (entries)
    // For sells, we handle via exit_on_whale_exit
    if (trade.side === 'SELL') return null;

    let outcome = trade.outcome;
    let side: OrderSide = 'BUY';

    // Inverse mode: flip direction
    if (this.cfg.copy_mode === 'inverse') {
      outcome = outcome === 'YES' ? 'NO' : 'YES';
    }

    // Confidence based on trade size (bigger whale trades = higher confidence)
    const sizeConfidence = Math.min(0.9, 0.4 + (trade.notionalUsd / 10_000) * 0.3);
    const edge = Math.min(0.05, (trade.notionalUsd / 50_000) * 0.04);

    return {
      marketId: trade.marketId,
      outcome,
      side,
      confidence: sizeConfidence,
      edge,
    };
  }

  /* ━━━━━━━━━━━━━━ Sizing Logic ━━━━━━━━━━━━━━ */

  private calculateSize(
    signal: Signal,
    whaleTrade: NormalisedWhaleTrade | undefined,
    price: number,
    available: number,
  ): number {
    const maxDollars = available * this.cfg.max_capital_per_trade_pct;
    let size: number;

    switch (this.cfg.size_mode) {
      case 'fixed':
        /* fixed_size is USD NOTIONAL (matches the dashboard form unit).
           Shares = dollars / price, then capped by capital + share caps. */
        size = Math.floor(this.cfg.fixed_size / Math.max(price, 0.01));
        break;

      case 'proportional': {
        const whaleSize = whaleTrade?.size ?? this.cfg.fixed_size;
        size = Math.floor(whaleSize * this.cfg.proportional_factor);
        break;
      }

      case 'kelly': {
        // Half-Kelly sizing
        const kellyFraction = signal.edge / Math.max(1 - signal.edge, 0.01);
        const halfKelly = kellyFraction * 0.5;
        const kellyDollars = available * Math.min(halfKelly, this.cfg.max_capital_per_trade_pct);
        size = Math.floor(kellyDollars / Math.max(price, 0.01));
        break;
      }

      default:
        size = this.cfg.fixed_size;
    }

    // Apply caps
    const maxFromCapital = Math.floor(maxDollars / Math.max(price, 0.01));
    size = Math.min(size, maxFromCapital, this.cfg.max_shares_per_order);

    return Math.max(0, size);
  }

  /* ━━━━━━━━━━━━━━ On-demand market metadata (gamma) ━━━━━━━━━━━━━━ */

  /** Markets the whale trades in may never appear in the engine's broadcast
   *  set — without market data, sizing silently drops every signal. Fetch
   *  the REAL row from gamma once per market and cache it. Real data or
   *  nothing: unusable/missing rows simply leave the market unknown. */
  private async ensureMarketData(marketId: string): Promise<void> {
    if (this.markets.has(marketId) || this.marketFetchInFlight.has(marketId)) return;
    this.marketFetchInFlight.add(marketId);
    try {
      const url = `${this.cfg.gamma_api_url}/markets?condition_ids=${encodeURIComponent(marketId)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`gamma HTTP ${res.status}`);
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      const m = rows[0];
      if (!m) return;

      const parseNum = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
      };
      const parseArr = (v: unknown): string[] => {
        if (Array.isArray(v)) return v.map(String);
        if (typeof v === 'string') {
          try {
            const j: unknown = JSON.parse(v);
            return Array.isArray(j) ? j.map(String) : [];
          } catch {
            return [];
          }
        }
        return [];
      };

      const outcomes = parseArr(m.outcomes);
      const prices = parseArr(m.outcomePrices).map(parseNum);
      const tokens = parseArr(m.clobTokenIds);
      if (outcomes.length < 2 || prices.length < 2 || tokens.length < 2) return;
      if (!prices.slice(0, 2).every(Number.isFinite)) return;

      const bid = parseNum(m.bestBid);
      const ask = parseNum(m.bestAsk);
      const hasQuote = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > bid;
      const mid = hasQuote ? (bid + ask) / 2 : prices[0];

      this.markets.set(marketId, {
        marketId,
        question: String(m.question ?? ''),
        slug: String(m.slug ?? ''),
        outcomes,
        outcomePrices: prices,
        clobTokenIds: tokens,
        midPrice: Number(mid.toFixed(4)),
        bid: hasQuote ? bid : Number(mid.toFixed(4)),
        ask: hasQuote ? ask : Number(mid.toFixed(4)),
        spread: hasQuote ? Number((ask - bid).toFixed(4)) : 0,
        volume24h: parseNum(m.volume24hr) || 0,
        liquidity: parseNum(m.liquidityNum) || 0,
        timestamp: Date.now(),
      });
      logger.info(
        { marketId, question: String(m.question ?? '').slice(0, 60) },
        '[copy_trade] whale market fetched from gamma',
      );
    } catch (err) {
      logger.warn(
        { marketId, err: (err as Error).message },
        '[copy_trade] gamma market fetch failed — signal will skip sizing this tick',
      );
    } finally {
      this.marketFetchInFlight.delete(marketId);
    }
  }

  /* ━━━━━━━━━━━━━━ Whale Exit Detection ━━━━━━━━━━━━━━ */

  private detectWhaleExits(trades: NormalisedWhaleTrade[], whaleAddress: string): void {
    const addr = whaleAddress.toLowerCase();
    const sellTrades = trades.filter((t) => t.side === 'SELL');

    for (const sell of sellTrades) {
      // Check if we have a position in this market that was copied from this whale
      const pos = this.positions.get(sell.marketId);
      if (pos && pos.whaleAddress.toLowerCase() === addr && !pos.whaleExited) {
        pos.whaleExited = true;
        logger.info({
          strategy: this.name,
          marketId: sell.marketId,
          whale: addr.slice(0, 10),
        }, 'Whale exit detected — will close mirrored position');
      }
    }
  }

  /* ━━━━━━━━━━━━━━ Performance Tracking ━━━━━━━━━━━━━━ */

  private recordTradeResult(whaleAddress: string, pnlBps: number): void {
    this.cumulativePnlBps += pnlBps;
    if (this.cumulativePnlBps > this.peakPnlBps) {
      this.peakPnlBps = this.cumulativePnlBps;
    }

    const perf = this.whalePerf.get(whaleAddress.toLowerCase());
    if (!perf) return;

    perf.totalPnlBps += pnlBps;

    if (pnlBps >= 0) {
      perf.wins++;
      perf.consecutiveLosses = 0;
    } else {
      perf.losses++;
      perf.consecutiveLosses++;

      // Consecutive loss cooldown
      if (perf.consecutiveLosses >= this.cfg.max_consecutive_losses) {
        perf.pausedUntil = Date.now() + this.cfg.cooldown_after_loss_seconds * 1000;
        const winRate = perf.wins / Math.max(perf.wins + perf.losses, 1);
        logger.warn({
          strategy: this.name,
          whale: whaleAddress.slice(0, 10),
          consecutiveLosses: perf.consecutiveLosses,
          winRate: winRate.toFixed(2),
          cooldownSeconds: this.cfg.cooldown_after_loss_seconds,
        }, `COPY_TRADE: whale on cooldown after ${perf.consecutiveLosses} consecutive losses`);
        consoleLog.warn('STRATEGY', `[copy_trade] Whale ${whaleAddress.slice(0, 10)}… paused — ${perf.consecutiveLosses} consecutive losses`);
      }
    }
  }

  private getCurrentDrawdownPct(): number {
    if (this.peakPnlBps <= 0) return 0;
    return Math.max(0, (this.peakPnlBps - this.cumulativePnlBps) / this.peakPnlBps);
  }

  private getMarketExposure(marketId: string): number {
    const pos = this.positions.get(marketId);
    if (!pos) return 0;
    return pos.entryPrice * pos.size;
  }

  private findWhaleForMarket(marketId: string): string | undefined {
    // Check the recentWhaleMap (populated during sizePositions)
    const recent = this.recentWhaleMap.get(marketId);
    if (recent) return recent;
    // Fall back to checking existing positions
    for (const [, pos] of this.positions) {
      if (pos.marketId === marketId) return pos.whaleAddress;
    }
    return undefined;
  }

  private getTotalTradesCopied(): number {
    let total = 0;
    for (const perf of this.whalePerf.values()) {
      total += perf.tradesCopied;
    }
    return total;
  }

  /* ━━━━━━━━━━━━━━ Daily Reset ━━━━━━━━━━━━━━ */

  private resetDailyIfNeeded(now: number): void {
    if (now >= this.dailyVolumeResetAt) {
      this.totalDailyVolumeUsd = 0;
      this.dailyVolumeResetAt = this.nextDayReset();
      this.drawdownPaused = false; // reset drawdown pause daily

      // Reset per-whale daily volumes
      for (const perf of this.whalePerf.values()) {
        if (now >= perf.dailyVolumeResetAt) {
          perf.dailyVolumeUsd = 0;
          perf.dailyVolumeResetAt = this.nextDayReset();
        }
      }
    }
  }

  private nextDayReset(): number {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return tomorrow.getTime();
  }

  /* ━━━━━━━━━━━━━━ Config Builder ━━━━━━━━━━━━━━ */

  private buildConfig(raw: Record<string, unknown>): CopyTradeConfig {
    const d = DEFAULT_COPY_TRADE_CONFIG;
    /* Array fields are CLONED — every instance owns its lists. Without this,
       addWhaleAddress() on one runner mutated the shared default/config array
       and silently appeared on every other copy_trade runner. */
    const arr = (v: unknown, fallback: string[]): string[] =>
      Array.isArray(v) ? [...(v as string[])] : [...fallback];
    return {
      whale_addresses: arr(raw.whale_addresses, d.whale_addresses),
      copy_mode: (raw.copy_mode as 'mirror' | 'inverse') ?? d.copy_mode,
      data_api_url: (raw.data_api_url as string) ?? d.data_api_url,
      gamma_api_url: (raw.gamma_api_url as string) ?? d.gamma_api_url,
      poll_interval_seconds: (raw.poll_interval_seconds as number) ?? d.poll_interval_seconds,
      max_polls_per_tick: (raw.max_polls_per_tick as number) ?? d.max_polls_per_tick,
      max_trade_age_seconds: (raw.max_trade_age_seconds as number) ?? d.max_trade_age_seconds,
      min_trade_size_usd: (raw.min_trade_size_usd as number) ?? d.min_trade_size_usd,
      max_trade_size_usd: (raw.max_trade_size_usd as number) ?? d.max_trade_size_usd,
      min_whale_win_rate: (raw.min_whale_win_rate as number) ?? d.min_whale_win_rate,
      size_mode: (raw.size_mode as 'fixed' | 'proportional' | 'kelly') ?? d.size_mode,
      fixed_size: (raw.fixed_size as number) ?? d.fixed_size,
      proportional_factor: (raw.proportional_factor as number) ?? d.proportional_factor,
      max_capital_per_trade_pct: (raw.max_capital_per_trade_pct as number) ?? d.max_capital_per_trade_pct,
      max_shares_per_order: (raw.max_shares_per_order as number) ?? d.max_shares_per_order,
      max_open_positions: (raw.max_open_positions as number) ?? d.max_open_positions,
      max_exposure_per_market_usd: (raw.max_exposure_per_market_usd as number) ?? d.max_exposure_per_market_usd,
      max_daily_volume_usd: (raw.max_daily_volume_usd as number) ?? d.max_daily_volume_usd,
      max_drawdown_pct: (raw.max_drawdown_pct as number) ?? d.max_drawdown_pct,
      max_consecutive_losses: (raw.max_consecutive_losses as number) ?? d.max_consecutive_losses,
      cooldown_after_loss_seconds: (raw.cooldown_after_loss_seconds as number) ?? d.cooldown_after_loss_seconds,
      take_profit_bps: (raw.take_profit_bps as number) ?? d.take_profit_bps,
      stop_loss_bps: (raw.stop_loss_bps as number) ?? d.stop_loss_bps,
      trailing_stop_activate_bps: (raw.trailing_stop_activate_bps as number) ?? d.trailing_stop_activate_bps,
      trailing_stop_distance_bps: (raw.trailing_stop_distance_bps as number) ?? d.trailing_stop_distance_bps,
      time_exit_minutes: (raw.time_exit_minutes as number) ?? d.time_exit_minutes,
      exit_on_whale_exit: (raw.exit_on_whale_exit as boolean) ?? d.exit_on_whale_exit,
      blacklist_markets: arr(raw.blacklist_markets, d.blacklist_markets),
      whitelist_markets: arr(raw.whitelist_markets, d.whitelist_markets),
      min_market_liquidity: (raw.min_market_liquidity as number) ?? d.min_market_liquidity,
      min_market_volume_24h: (raw.min_market_volume_24h as number) ?? d.min_market_volume_24h,
    };
  }

  /* ━━━━━━━━━━━━━━ Public Accessors (for testing / dashboard) ━━━━━━━━━━━━━━ */

  getConfig(): CopyTradeConfig { return { ...this.cfg }; }
  getPositions(): Map<string, CopyPosition> { return new Map(this.positions); }
  getWhalePerformance(): Map<string, WhalePerformance> { return new Map(this.whalePerf); }
  getStats(): {
    totalCopied: number;
    openPositions: number;
    cumulativePnlBps: number;
    drawdownPct: number;
    dailyVolumeUsd: number;
    drawdownPaused: boolean;
  } {
    return {
      totalCopied: this.getTotalTradesCopied(),
      openPositions: this.positions.size,
      cumulativePnlBps: this.cumulativePnlBps,
      drawdownPct: this.getCurrentDrawdownPct(),
      dailyVolumeUsd: this.totalDailyVolumeUsd,
      drawdownPaused: this.drawdownPaused,
    };
  }

  /**
   * OPERATOR LAW: the operator's START button outranks this strategy's
   * software self-stops. Clears the drawdown circuit breaker and every
   * per-whale consecutive-loss cooldown so the lane trades again
   * immediately. Called only by engine.resumeRunner (dashboard START).
   */
  override onOperatorResume(): void {
    let clearedWhales = 0;
    for (const perf of this.whalePerf.values()) {
      if (perf.pausedUntil > 0 || perf.consecutiveLosses > 0) {
        perf.pausedUntil = 0;
        perf.consecutiveLosses = 0;
        clearedWhales++;
      }
    }
    const wasDrawdownPaused = this.drawdownPaused;
    this.drawdownPaused = false;
    if (wasDrawdownPaused || clearedWhales > 0) {
      consoleLog.success(
        'STRATEGY',
        `[copy_trade] OPERATOR RESUME — self-stops cleared (drawdown breaker: ${
          wasDrawdownPaused ? 'cleared' : 'not set'
        }, loss-cooldown whales cleared: ${clearedWhales})`,
      );
    }
  }

  /* ━━━━━━━━━━━━━━ Runtime whale address management ━━━━━━━━━━━━━━ */

  /** Per-lane copy links the operator turned OFF. addWhaleAddress refuses
   *  denied addresses, so the 60s tracker bridge can never re-enable one
   *  behind the operator's back. */
  private readonly whaleDeny = new Set<string>();

  /** Add a whale address at runtime. Returns false if already tracked or operator-denied. */
  addWhaleAddress(address: string): boolean {
    const addr = address.toLowerCase().trim();
    if (this.whaleDeny.has(addr)) return false; // operator turned this copy link OFF
    if (!addr || this.cfg.whale_addresses.map(a => a.toLowerCase()).includes(addr)) return false;
    this.cfg.whale_addresses.push(addr);
    if (!this.whalePerf.has(addr)) {
      this.whalePerf.set(addr, {
        address: addr,
        tradesCopied: 0,
        wins: 0,
        losses: 0,
        totalPnlBps: 0,
        consecutiveLosses: 0,
        pausedUntil: 0,
        dailyVolumeUsd: 0,
        dailyVolumeResetAt: this.nextDayReset(),
      });
    }
    logger.info({ strategy: this.name, address: addr, totalWhales: this.cfg.whale_addresses.length }, 'Whale address added');
    consoleLog.success('STRATEGY', `[copy_trade] Added whale ${addr.slice(0, 10)}… — now tracking ${this.cfg.whale_addresses.length} whale(s)`);
    return true;
  }

  /** Remove a whale address at runtime. Returns false if not found. */
  removeWhaleAddress(address: string): boolean {
    const addr = address.toLowerCase().trim();
    const idx = this.cfg.whale_addresses.findIndex(a => a.toLowerCase() === addr);
    if (idx === -1) return false;
    this.cfg.whale_addresses.splice(idx, 1);
    logger.info({ strategy: this.name, address: addr, totalWhales: this.cfg.whale_addresses.length }, 'Whale address removed');
    consoleLog.warn('STRATEGY', `[copy_trade] Removed whale ${addr.slice(0, 10)}… — now tracking ${this.cfg.whale_addresses.length} whale(s)`);
    return true;
  }

  /** Get the list of tracked whale addresses. */
  getWhaleAddresses(): string[] {
    return [...this.cfg.whale_addresses];
  }

  /** Wallet this lane trades for ('' before initialize). The whale-wiring
   *  paths use this to skip whole-account LIVE wallets: a LIVE account wallet
   *  never auto-copies whales — real-money copying runs on LIVE lanes the
   *  operator explicitly creates. */
  getWalletId(): string {
    return this.context?.wallet.walletId ?? '';
  }

  isWhaleDenied(address: string): boolean {
    return this.whaleDeny.has(address.toLowerCase().trim());
  }

  /** Turn a copy link OFF: deny the address AND stop following it immediately.
   *  The deny survives the tracker bridge, which calls addWhaleAddress. */
  denyWhaleAddress(address: string): boolean {
    const addr = address.toLowerCase().trim();
    if (!addr) return false;
    this.whaleDeny.add(addr);
    const idx = this.cfg.whale_addresses.findIndex(a => a.toLowerCase() === addr);
    if (idx !== -1) this.cfg.whale_addresses.splice(idx, 1);
    logger.info({ strategy: this.name, address: addr }, 'Whale copy link DENIED by operator');
    return true;
  }

  /** Turn a copy link back ON: clears the deny (the caller re-adds the address). */
  allowWhaleAddress(address: string): boolean {
    return this.whaleDeny.delete(address.toLowerCase().trim());
  }

  override shutdown(): void {
    logger.info({ strategy: this.name, totalCopied: this.getTotalTradesCopied() }, 'Copy Trade strategy shutdown');
  }
}

/* ━━━━━━━━━━━━━━ Whale Tracking → copy-trade bridge ━━━━━━━━━━━━━━ */

/**
 * Push the Whale Tracking Engine's tracked addresses into every copy_trade
 * instance (PAPER and LIVE runners alike) so the strategies poll the real
 * Data API for exactly those whales. Idempotent — addresses already followed
 * are skipped, and manual whale_addresses from config.yaml stay in effect.
 * Returns how many addresses were added across all instances.
 */
export function syncTrackedWhalesIntoCopyTrade(
  instances: CopyTradeStrategy[],
  trackedAddresses: string[],
): number {
  const tracked = trackedAddresses.map((a) => a.toLowerCase().trim()).filter(Boolean);
  let added = 0;
  for (const inst of instances) {
    const current = inst.getWhaleAddresses().map((a) => a.toLowerCase());
    for (const addr of tracked) {
      if (!current.includes(addr) && inst.addWhaleAddress(addr)) added++;
    }
  }
  return added;
}
