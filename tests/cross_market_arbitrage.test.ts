import { describe, it, expect } from 'vitest';
import { CrossMarketArbitrageStrategy } from '../src/strategies/arbitrage/cross_market_arbitrage';
import { MarketData, WalletState } from '../src/types';

const state: WalletState = {
  walletId: 'paper_arb_test',
  mode: 'PAPER',
  assignedStrategy: 'cross_market_arbitrage',
  capitalAllocated: 10_000,
  availableBalance: 10_000,
  openPositions: [],
  realizedPnl: 0,
  riskLimits: {
    maxPositionSize: 100,
    maxExposurePerMarket: 200,
    maxDailyLoss: 100,
    maxOpenTrades: 5,
    maxDrawdown: 0.2,
  },
};

/** Overpriced market: YES+NO = 1.17, all quality filters pass. */
function overpricedMarket(): MarketData {
  return {
    marketId: 'mkt-over',
    question: 'Overpriced?',
    slug: 'overpriced',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.62, 0.55],
    clobTokenIds: ['tok-yes', 'tok-no'],
    midPrice: 0.62,
    bid: 0.6,
    ask: 0.64,
    spread: 0.04,
    volume24h: 50_000,
    liquidity: 10_000,
    timestamp: Date.now(),
  };
}

/** Underpriced market: YES+NO = 0.75 → BUY the cheap side. */
function underpricedMarket(): MarketData {
  return {
    ...overpricedMarket(),
    marketId: 'mkt-under',
    slug: 'underpriced',
    outcomePrices: [0.35, 0.4],
    midPrice: 0.35,
    bid: 0.34,
    ask: 0.36,
  };
}

function strategyWith(...markets: MarketData[]): CrossMarketArbitrageStrategy {
  const s = new CrossMarketArbitrageStrategy();
  s.initialize({ wallet: state, config: {} });
  for (const m of markets) s.onMarketUpdate(m);
  return s;
}

describe('CrossMarketArbitrageStrategy (spam fixes)', () => {
  it('does not emit a naked SELL for an overpriced market with no inventory', () => {
    const s = strategyWith(overpricedMarket());
    const signals = s.generateSignals();
    expect(signals.filter((sig) => sig.side === 'SELL')).toHaveLength(0);
  });

  it('emits the SELL once the strategy tracks inventory for that outcome', () => {
    const s = strategyWith(overpricedMarket());
    // Simulate a filled BUY YES (what notifyFill would record via the engine).
    s.notifyFill({
      walletId: state.walletId,
      marketId: 'mkt-over',
      outcome: 'YES',
      side: 'BUY',
      price: 0.5,
      size: 10,
      strategy: 'cross_market_arbitrage',
    });
    const signals = s.generateSignals();
    const sells = signals.filter((sig) => sig.side === 'SELL');
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ marketId: 'mkt-over', outcome: 'YES' });
  });

  it('arms the per-market cooldown when sizing — no immediate re-attempt', () => {
    const s = strategyWith(underpricedMarket());
    const first = s.sizePositions(s.generateSignals());
    expect(first.length).toBeGreaterThanOrEqual(1);
    // Same signal again within the 60s cooldown must be filtered out.
    const second = s.sizePositions(s.generateSignals());
    expect(second).toHaveLength(0);
  });
});
