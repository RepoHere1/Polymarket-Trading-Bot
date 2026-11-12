import { describe, it, expect, afterEach, vi } from 'vitest';
import { MispricingArbitrageStrategy } from '../src/strategies/arbitrage/mispricing_detector';
import { MarketData, WalletState } from '../src/types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Mispricing arbitrage — 2026-11-11 defect fixes:
   1. no more dust-longshot entries (price band + real book required)
   2. NO orders priced as the complement of the YES book (was: YES bid)
   3. no fabricated fallback prices when the book is missing
   4. open wallet positions adopted on restart → TIME_EXIT can drain
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

afterEach(() => {
  vi.useRealTimers();
});

function mkMarket(overrides: Partial<MarketData> = {}): MarketData {
  return {
    marketId: 'mkt-1',
    question: 'Will X happen?',
    slug: 'will-x-happen',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.55, 0.45],
    clobTokenIds: ['tok-1', 'tok-2'],
    midPrice: 0.55,
    bid: 0.54,
    ask: 0.56,
    spread: 0.02,
    volume24h: 50_000,
    liquidity: 20_000,
    timestamp: Date.now(),
    ...overrides,
  };
}

function mkWallet(overrides: Partial<WalletState> = {}): WalletState {
  return {
    walletId: 'paper_mispricing_arb',
    mode: 'PAPER',
    assignedStrategy: 'mispricing_arbitrage',
    capitalAllocated: 1_000,
    availableBalance: 1_000,
    openPositions: [],
    realizedPnl: 0,
    riskLimits: {
      maxPositionSize: 500,
      maxExposurePerMarket: 1_000,
      maxDailyLoss: 500,
      maxOpenTrades: 50,
      maxDrawdown: 0.1,
    },
    ...overrides,
  };
}

/** Feed the strategy enough fresh snapshots at `price` to build a VWAP. */
function feedSnapshots(strategy: MispricingArbitrageStrategy, market: MarketData, prices: number[]): void {
  let volume = 10_000;
  for (const p of prices) {
    volume += 1_000;
    strategy.onMarketUpdate({
      ...market,
      midPrice: p,
      outcomePrices: [p, Number((1 - p).toFixed(2))],
      volume24h: volume,
      timestamp: Date.now(),
    });
  }
}

describe('mispricing — dust and phantom-edge guards', () => {
  it('generates NO signal for a sub-5-cent longshot market', () => {
    const s = new MispricingArbitrageStrategy();
    s.initialize({ wallet: mkWallet(), config: {} });
    const dust = mkMarket({ outcomePrices: [0.03, 0.97], midPrice: 0.03, bid: 0.02, ask: 0.04, spread: 0.02 });
    feedSnapshots(s, dust, [0.5, 0.5, 0.5, 0.5]);
    s.onMarketUpdate(dust);
    expect(s.generateSignals()).toEqual([]);
  });

  it('generates NO signal without a real two-sided book', () => {
    const s = new MispricingArbitrageStrategy();
    s.initialize({ wallet: mkWallet(), config: {} });
    const noBook = mkMarket({ bid: 0, ask: 0, spread: 0 });
    feedSnapshots(s, noBook, [0.7, 0.7, 0.7, 0.7]);
    s.onMarketUpdate(noBook);
    expect(s.generateSignals()).toEqual([]);
  });

  it('no fabricated fallback price: a signal whose market left the cache is skipped, not re-quoted', () => {
    const s = new MispricingArbitrageStrategy();
    s.initialize({ wallet: mkWallet(), config: {} });
    const m = mkMarket();
    feedSnapshots(s, m, [0.7, 0.7, 0.7, 0.7]);
    s.onMarketUpdate(m);

    const signals = s.generateSignals();
    expect(signals.length).toBeGreaterThan(0);

    /* Market drops out of the live cache between generateSignals and
       sizePositions — old code invented a 0.98×mid quote. Now: skip. */
    (s as unknown as { markets: Map<string, MarketData> }).markets.clear();
    expect(s.sizePositions(signals)).toEqual([]);
  });
});

describe('mispricing — per-outcome pricing', () => {
  it('prices a YES BUY at the YES bid', () => {
    const s = new MispricingArbitrageStrategy();
    s.initialize({ wallet: mkWallet(), config: {} });
    const m = mkMarket(); // yes 0.55, bid 0.54 ask 0.56
    feedSnapshots(s, m, [0.7, 0.7, 0.7, 0.7]); // VWAP high → YES looks cheap
    s.onMarketUpdate(m);

    const orders = s.sizePositions(s.generateSignals());
    expect(orders.length).toBeGreaterThan(0);
    const yes = orders.find((o) => o.outcome === 'YES');
    expect(yes).toBeDefined();
    expect(yes!.price).toBe(0.54);
    expect(yes!.price).toBeGreaterThanOrEqual(0.02);
  });

  it('prices a NO BUY as the complement of the YES book, not the YES bid', () => {
    const s = new MispricingArbitrageStrategy();
    s.initialize({ wallet: mkWallet(), config: {} });
    const m = mkMarket(); // yes 0.55, bid 0.54 ask 0.56
    feedSnapshots(s, m, [0.3, 0.3, 0.3, 0.3]); // VWAP low → NO looks cheap
    s.onMarketUpdate(m);

    const orders = s.sizePositions(s.generateSignals());
    const no = orders.find((o) => o.outcome === 'NO');
    expect(no).toBeDefined();
    /* NO bid = 1 - YES ask = 1 - 0.56 = 0.44 — NOT the old buggy 0.54 */
    expect(no!.price).toBeCloseTo(0.44, 4);
  });
});

describe('mispricing — orphan adoption on restart', () => {
  it('adopts the wallet\'s open positions and TIME_EXITs them after 15 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());

    const wallet = mkWallet({
      openPositions: [
        { marketId: 'mkt-1', outcome: 'YES', size: 2, avgPrice: 0.009, realizedPnl: 0 },
        { marketId: 'mkt-1', outcome: 'NO', size: 14, avgPrice: 0.991, realizedPnl: 0 },
      ],
    });
    const s = new MispricingArbitrageStrategy();
    s.initialize({ wallet, config: {} });

    /* Market still cached at the entry price so no TP/SL fires early */
    s.onMarketUpdate(mkMarket({
      marketId: 'mkt-1',
      outcomePrices: [0.009, 0.991],
      midPrice: 0.009,
      bid: 0.004,
      ask: 0.014,
      spread: 0.01,
    }));

    s.managePositions();
    expect(s.drainExitOrders()).toEqual([]); // fresh adoption — not yet 15 min

    vi.advanceTimersByTime(16 * 60_000);
    s.managePositions();
    const exits = s.drainExitOrders();
    expect(exits).toHaveLength(2);
    for (const exit of exits) {
      expect(exit.side).toBe('SELL');
      expect(exit.strategy).toBe('mispricing_arbitrage');
    }
  });
});
