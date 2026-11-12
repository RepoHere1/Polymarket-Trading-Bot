import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, MarketData, OrderRequest } from '../../types';
import { logger } from '../../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Mispricing Arbitrage Strategy – Enhanced
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Multi-factor mispricing detector that combines:
   1. Spread analysis – wide bid-ask as a percentage of mid
   2. Volume-weighted fair value estimation (VWAP deviation)
   3. Price-volume divergence – volume surging but price stagnant
   4. Mean-reversion scoring – deviation from rolling average
   5. Order-flow imbalance – bid vs ask side depth proxy
   6. Cross-market validation – compare with related event markets

   Position management:
   • Kelly-inspired sizing with max position constraints
   • Time-based exit (mispricing should correct within 20 min)
   • Profit-taking at 60 bps, stop-loss at 80 bps
   • Trailing stop after 40 bps gain
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const MIN_VOLUME = 1_000;
const MIN_LIQUIDITY = 200;
const STALE_MS = 60_000;
const MIN_SPREAD_PCT = 0.006; // 0.6% minimum spread to flag
const MAX_CONFIDENCE = 0.90;
const MAX_POSITIONS = 15;

/** Rolling price snapshot for VWAP-like estimation */
interface PriceSnapshot {
  price: number;
  volume: number;
  timestamp: number;
}

/** Tracked mispricing position */
interface MispricingPosition {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  entryTime: number;
  mispricingScore: number;
  peakBps: number;
}

export class MispricingArbitrageStrategy extends BaseStrategy {
  readonly name = 'mispricing_arbitrage';
  protected override cooldownMs = 45_000;

  private positions: MispricingPosition[] = [];
  private priceSnapshots = new Map<string, PriceSnapshot[]>();
  private volumeHistory = new Map<string, number[]>();

  /* ── Market update ──────────────────────────────────────────── */
  override onMarketUpdate(data: MarketData): void {
    super.onMarketUpdate(data);

    // Track price snapshots
    const snaps = this.priceSnapshots.get(data.marketId) ?? [];
    snaps.push({
      price: data.midPrice,
      volume: data.volume24h,
      timestamp: data.timestamp,
    });
    if (snaps.length > 40) snaps.shift();
    this.priceSnapshots.set(data.marketId, snaps);

    // Track volume history
    const vols = this.volumeHistory.get(data.marketId) ?? [];
    vols.push(data.volume24h);
    if (vols.length > 20) vols.shift();
    this.volumeHistory.set(data.marketId, vols);
  }

  /* ── Lifecycle ──────────────────────────────────────────────── */

  /**
   * ADOPT ORPHANS 2026-11-11: `this.positions` used to be in-memory only,
   * so every restart orphaned the wallet's open positions — managePositions
   * could never exit them again and the wallet accumulated dead dust
   * (PolyFake-02 held 10 sub-5-cent positions with realizedPnl 0). On
   * initialize we adopt whatever the wallet still holds; TIME_EXIT (15 min)
   * then drains anything stale.
   */
  override initialize(context: StrategyContext): void {
    super.initialize(context);
    const orphans = context.wallet.openPositions ?? [];
    for (const pos of orphans) {
      this.positions.push({
        marketId: pos.marketId,
        outcome: pos.outcome,
        side: 'BUY', // paper positions open via BUY fills
        entryPrice: pos.avgPrice,
        size: pos.size,
        entryTime: Date.now(),
        mispricingScore: 0,
        peakBps: 0,
      });
    }
    if (orphans.length > 0) {
      logger.info(
        { strategy: this.name, adopted: orphans.length },
        'Adopted open wallet positions on restart — exit management resumes',
      );
    }
  }

  /* ── Signal generation ──────────────────────────────────────── */
  generateSignals(): Signal[] {
    const signals: Signal[] = [];
    if (this.positions.length >= MAX_POSITIONS) return signals;

    const now = Date.now();
    const eventGroups = this.groupByEvent();

    for (const [marketId, market] of this.markets) {
      if (!this.passesFilters(market, now)) continue;

      const score = this.computeMispricingScore(marketId, market, eventGroups);
      if (score.total < 0.3) continue; // Not enough mispricing evidence

      /* VWAP-deviation entries ONLY (2026-11-11 fix).
         The old "spread fallback" bought whichever side was <0.5 whenever
         VWAP wasn't ready — a phantom edge that mostly bought illiquid
         longshots. Real spread capture needs passive limit fills the paper
         executor doesn't model, so we only trade a measured deviation from
         OUR OWN volume-weighted price history, at a size that matters. */
      const snaps = this.priceSnapshots.get(marketId) ?? [];
      const vwap = this.computeVWAP(snaps);
      const yesPrice = market.outcomePrices[0];

      if (vwap <= 0 || Math.abs(yesPrice - vwap) < 0.01) continue; // need ≥1 cent of real deviation

      let direction: 'YES' | 'NO';
      let side: 'BUY' | 'SELL';
      let edge: number;

      if (yesPrice < vwap) {
        direction = 'YES';
        side = 'BUY';
        edge = vwap - yesPrice;
      } else {
        direction = 'NO';
        side = 'BUY';
        edge = yesPrice - vwap;
      }

      // Boost edge with volume-price divergence
      const volDivergence = this.volumePriceDivergence(marketId);
      if (volDivergence > 0.5) {
        edge *= 1 + volDivergence * 0.3;
      }

      const confidence = Math.min(MAX_CONFIDENCE, score.total * 1.2);

      signals.push({
        marketId,
        outcome: direction,
        side,
        confidence,
        edge: Math.min(edge, 0.08),
      });
    }

    // Sort by mispricing score (best first)
    signals.sort((a, b) => b.confidence * b.edge - a.confidence * a.edge);
    return signals.slice(0, MAX_POSITIONS - this.positions.length);
  }

  /* ── Sizing: risk-adjusted with Kelly ───────────────────────── */
  override sizePositions(signals: Signal[]): OrderRequest[] {
    const capital = this.context?.wallet.availableBalance ?? 100;
    const walletId = this.context?.wallet.walletId ?? 'unknown';
    const now = Date.now();

    return signals
      .filter((s) => {
        const key = `${s.marketId}:${s.outcome}:${s.side}`;
        const last = this.tradeCooldowns.get(key) ?? 0;
        return now - last > this.cooldownMs;
      })
      .map((signal) => {
        const market = this.markets.get(signal.marketId);

        /* REAL BOOK REQUIRED (2026-11-11 fix): no fabricated fallback
           prices (the old `?? midPrice * 0.98` invented quotes for markets
           without books). bid/ask belong to the YES token — sanity-check
           them against the mid so an anomalous book can't produce a
           $0.002 "fill", and price the NO outcome as the complement of
           the YES book (the old code bought NO at the YES bid — garbage
           fills). */
        if (!market || !(market.bid > 0) || !(market.ask < 1) || market.ask <= market.bid) return null;
        const mid = market.midPrice > 0 ? market.midPrice : (market.bid + market.ask) / 2;
        if (market.bid < mid * 0.8 || market.ask > mid * 1.2) return null; // anomalous book
        if (market.spread > 0.05) return null; // exit slippage exceeds captured edge

        let price: number;
        if (signal.outcome === 'YES') {
          price = signal.side === 'BUY' ? market.bid : market.ask;
        } else {
          /* NO token book is the complement of the YES book */
          price = signal.side === 'BUY' ? 1 - market.ask : 1 - market.bid;
        }
        price = Number(price.toFixed(4));
        if (price < 0.02 || price > 0.98) return null; // never trade dust

        // Arm the per-market cooldown only when an order is actually
        // produced — skipped markets stay eligible next scan.
        this.tradeCooldowns.set(`${signal.marketId}:${signal.outcome}:${signal.side}`, now);

        const liquidity = market.liquidity;

        // Half-Kelly sizing
        const winProb = 0.5 + signal.edge;
        const kellyFrac = Math.max(0, (winProb * 2 - 1) / 1) / 2;

        const maxFromCapital = capital * Math.min(kellyFrac, 0.05);
        const maxFromLiquidity = liquidity * 0.008;
        const size = Math.max(1, Math.floor(Math.min(maxFromCapital, maxFromLiquidity, 50)));

        return {
          walletId,
          marketId: signal.marketId,
          outcome: signal.outcome,
          side: signal.side,
          price,
          size,
          strategy: this.name,
        };
      })
      .filter((o): o is OrderRequest => o !== null);
  }

  /* ── Position tracking via engine callback ──────────────────── */
  override notifyFill(order: OrderRequest): void {
    if (order.strategy !== this.name) return;
    this.positions.push({
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      entryPrice: order.price,
      size: order.size,
      entryTime: Date.now(),
      mispricingScore: 0,
      peakBps: 0,
    });
  }

  /** Legacy — position tracking now handled by notifyFill */
  override submitOrders(_orders: OrderRequest[]): void {
    return;
  }

  /* ── Manage positions ───────────────────────────────────────── */
  override managePositions(): void {
    const toRemove: number[] = [];

    for (let i = 0; i < this.positions.length; i++) {
      const pos = this.positions[i];
      const market = this.markets.get(pos.marketId);
      if (!market) continue;

      const currentPrice = pos.outcome === 'YES'
        ? market.outcomePrices[0]
        : market.outcomePrices[1];

      const edgeBps = pos.side === 'BUY'
        ? (currentPrice - pos.entryPrice) * 10_000
        : (pos.entryPrice - currentPrice) * 10_000;

      pos.peakBps = Math.max(pos.peakBps, edgeBps);
      const holdingMin = (Date.now() - pos.entryTime) / 60_000;

      let exitReason: string | undefined;

      // 1. Take profit at 100 bps
      if (edgeBps >= 100) { exitReason = 'TAKE_PROFIT'; }

      // 2. Stop-loss at 60 bps adverse
      if (!exitReason && edgeBps <= -60) { exitReason = 'STOP_LOSS'; }

      // 3. Trailing stop: was up 50+ bps, dropped 25 from peak
      if (!exitReason && pos.peakBps > 50 && edgeBps < pos.peakBps - 25) {
        exitReason = 'TRAILING_STOP';
      }

      // 4. Time exit: mispricings should correct within 15 min
      if (!exitReason && holdingMin > 15) { exitReason = 'TIME_EXIT'; }

      // 5. Spread normalized: no longer mispriced
      if (!exitReason && market.spread < 0.003 && holdingMin > 2) {
        exitReason = 'SPREAD_NORMAL';
      }

      if (exitReason) {
        toRemove.push(i);

        const exitSide: 'BUY' | 'SELL' = pos.side === 'BUY' ? 'SELL' : 'BUY';
        this.pendingExits.push({
          walletId: this.context?.wallet.walletId ?? 'unknown',
          marketId: pos.marketId,
          outcome: pos.outcome,
          side: exitSide,
          price: currentPrice,
          size: pos.size,
          strategy: this.name,
        });
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.positions.splice(toRemove[i], 1);
    }
  }

  /* ── Multi-factor mispricing score ──────────────────────────── */
  private computeMispricingScore(
    marketId: string,
    market: MarketData,
    eventGroups: Map<string, MarketData[]>,
  ): { total: number; spread: number; vwapDev: number; volDiv: number; meanRev: number; crossMkt: number } {
    // Factor 1: Spread width (wider = more mispriced)
    const spreadPct = market.spread / Math.max(market.midPrice, 0.01);
    const spreadScore = Math.min(1, (spreadPct - MIN_SPREAD_PCT) / 0.04);

    // Factor 2: VWAP deviation
    const snaps = this.priceSnapshots.get(marketId) ?? [];
    const vwap = this.computeVWAP(snaps);
    const vwapDev = vwap > 0 ? Math.abs(market.midPrice - vwap) / Math.max(vwap, 0.01) : 0;
    const vwapScore = Math.min(1, vwapDev / 0.03);

    // Factor 3: Volume-price divergence
    const volDiv = this.volumePriceDivergence(marketId);
    const volDivScore = Math.min(1, volDiv);

    // Factor 4: Mean reversion potential
    const meanRevScore = this.meanReversionScore(marketId);

    // Factor 5: Cross-market validation
    const crossMktScore = this.crossMarketScore(market, eventGroups);

    const total =
      spreadScore * 0.25 +
      vwapScore * 0.25 +
      volDivScore * 0.15 +
      meanRevScore * 0.20 +
      crossMktScore * 0.15;

    return { total, spread: spreadScore, vwapDev: vwapScore, volDiv: volDivScore, meanRev: meanRevScore, crossMkt: crossMktScore };
  }

  /* ── Helpers ────────────────────────────────────────────────── */

  private computeVWAP(snapshots: PriceSnapshot[]): number {
    if (snapshots.length < 3) return 0;
    let sumPriceVol = 0;
    let sumVol = 0;
    for (let i = 1; i < snapshots.length; i++) {
      // Use volume DELTA between snapshots as weight (actual traded volume)
      const volDelta = Math.max(1, snapshots[i].volume - snapshots[i - 1].volume);
      sumPriceVol += snapshots[i].price * volDelta;
      sumVol += volDelta;
    }
    return sumVol > 0 ? sumPriceVol / sumVol : 0;
  }

  private volumePriceDivergence(marketId: string): number {
    const snaps = this.priceSnapshots.get(marketId) ?? [];
    if (snaps.length < 5) return 0;

    const recent = snaps.slice(-10);
    const priceChange = Math.abs(recent[recent.length - 1].price - recent[0].price);
    const volumeChange = recent.length > 1
      ? Math.abs(recent[recent.length - 1].volume - recent[0].volume) / Math.max(recent[0].volume, 1)
      : 0;

    // High volume change with low price change = divergence
    if (priceChange < 0.005 && volumeChange > 0.1) {
      return Math.min(1, volumeChange * 3);
    }
    return 0;
  }

  private meanReversionScore(marketId: string): number {
    const snaps = this.priceSnapshots.get(marketId) ?? [];
    if (snaps.length < 10) return 0;

    const prices = snaps.map((s) => s.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const current = prices[prices.length - 1];
    const deviation = Math.abs(current - avg);

    // Standard deviation
    const variance = prices.reduce((sum, p) => sum + (p - avg) ** 2, 0) / prices.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // Z-score: how many standard deviations from mean
    const zScore = deviation / stdDev;
    // Mean reversion opportunity if |z| > 1.5
    return Math.min(1, Math.max(0, (zScore - 1) / 2));
  }

  private crossMarketScore(market: MarketData, eventGroups: Map<string, MarketData[]>): number {
    if (!market.eventId) return 0;
    const group = eventGroups.get(market.eventId);
    if (!group || group.length < 2) return 0;

    // Compare this market's spread to others in the same event
    const spreads = group.map((m) => m.spread / Math.max(m.midPrice, 0.01));
    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const thisSpread = market.spread / Math.max(market.midPrice, 0.01);

    // If this market has a significantly wider spread than peers, it's mispriced
    if (thisSpread > avgSpread * 1.5) {
      return Math.min(1, (thisSpread - avgSpread) / avgSpread);
    }
    return 0;
  }

  private passesFilters(market: MarketData, now: number): boolean {
    if (market.volume24h < MIN_VOLUME) return false;
    if (market.liquidity < MIN_LIQUIDITY) return false;
    if (now - market.timestamp > STALE_MS) return false;

    const yesPrice = market.outcomePrices[0] ?? 0.5;
    if (yesPrice < 0.05 || yesPrice > 0.95) return false;
    const noPrice = market.outcomePrices[1];
    if (noPrice !== undefined && (noPrice < 0.05 || noPrice > 0.95)) return false;

    /* Real two-sided book (2026-11-11): crossed/one-sided books produce
       phantom mispricings, and wide spreads make the exit cost exceed the
       captured edge. */
    if (!(market.bid > 0) || !(market.ask < 1) || market.ask <= market.bid) return false;
    if (market.spread > 0.05) return false;

    const spreadPct = market.spread / Math.max(market.midPrice, 0.01);
    if (spreadPct < MIN_SPREAD_PCT) return false;

    return true;
  }

  private groupByEvent(): Map<string, MarketData[]> {
    const groups = new Map<string, MarketData[]>();
    for (const [, market] of this.markets) {
      const eventId = market.eventId;
      if (!eventId) continue;
      const group = groups.get(eventId) ?? [];
      group.push(market);
      groups.set(eventId, group);
    }
    return groups;
  }
}
