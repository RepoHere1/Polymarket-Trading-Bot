import { describe, it, expect } from 'vitest';
import { computePerformance, buildDashboardPayload } from '../src/reporting/dashboard_api';
import { buildWalletDetail } from '../src/reporting/dashboard_server';
import { WalletState, TradeRecord } from '../src/types';

function state(over: Partial<WalletState> = {}): WalletState {
  return {
    walletId: 'w1',
    mode: 'PAPER',
    assignedStrategy: 'test',
    capitalAllocated: 50,
    availableBalance: 30,
    openPositions: [],
    realizedPnl: -0.62,
    riskLimits: {
      maxPositionSize: 10,
      maxExposurePerMarket: 15,
      maxDailyLoss: 5,
      maxOpenTrades: 10,
      maxDrawdown: 0.2,
    },
    ...over,
  };
}

let seq = 0;
function trade(side: 'BUY' | 'SELL', realizedPnl: number, over: Partial<TradeRecord> = {}): TradeRecord {
  seq += 1;
  return {
    orderId: `o${seq}`,
    walletId: 'w1',
    marketId: 'm1',
    outcome: 'NO',
    side,
    price: 0.5,
    size: 10,
    cost: 5,
    fee: 0.02,
    feeAsset: 'USDC',
    realizedPnl,
    cumulativePnl: realizedPnl,
    balanceAfter: 30,
    timestamp: 1_000 + seq,
    ...over,
  };
}

describe('dashboard performance metrics are outcome-based (SELLs only)', () => {
  it('does not count BUY fees as losses — a holding-only wallet has 0 closed trades', () => {
    const buys = [
      trade('BUY', -0.02),
      trade('BUY', -0.03),
      trade('BUY', -0.02), // 3 buys, each "realized" is just the fee
    ];
    const p = computePerformance(state(), buys, 39.03);
    expect(p.totalTrades).toBe(3);
    expect(p.closedTrades).toBe(0);
    expect(p.winCount).toBe(0);
    expect(p.lossCount).toBe(0); // the lie: used to be 0W/3L
    expect(p.winRate).toBe(0);
    expect(p.profitFactor).toBe(0);
    expect(p.totalPnl).toBeCloseTo(38.41, 4);
  });

  it('classifies wins/losses from SELL outcomes only', () => {
    const trades = [
      trade('BUY', -0.02),
      trade('SELL', 1.5),
      trade('BUY', -0.03),
      trade('SELL', -0.75),
      trade('SELL', 0.5),
    ];
    const p = computePerformance(state(), trades, 0);
    expect(p.totalTrades).toBe(5);
    expect(p.closedTrades).toBe(3);
    expect(p.winCount).toBe(2);
    expect(p.lossCount).toBe(1);
    expect(p.winRate).toBeCloseTo(2 / 3, 4);
    expect(p.profitFactor).toBeCloseTo(Math.abs(2.0 / -0.75), 4); // from SELLs only
    expect(p.avgWin).toBeCloseTo(1.0, 4);
    expect(p.avgLoss).toBeCloseTo(-0.75, 4);
  });
});

describe('dashboard summary — running wallets and LIVE capital truth', () => {
  it('activeWallets counts only RUNNING runners; totalWallets counts everything', () => {
    const payload = buildDashboardPayload(
      [state({ walletId: 'w1' }), state({ walletId: 'w2' }), state({ walletId: 'w3' })],
      new Map([['w1', []], ['w2', []], ['w3', []]]),
      undefined,
      new Set(['w2']), // paused
      undefined,
      new Set(['w1']), // running = runner attached AND not paused
    );
    expect(payload.totalWallets).toBe(3);
    expect(payload.activeWallets).toBe(1); // only w1 runs; w2 is paused, w3 has no runner
  });

  it('without running info every wallet counts (back-compat)', () => {
    const payload = buildDashboardPayload([state()], new Map([['w1', []]]));
    expect(payload.activeWallets).toBe(1);
    expect(payload.totalWallets).toBe(1);
  });

  it('LIVE capital is the exchange balance, not the configured number', () => {
    const payload = buildDashboardPayload(
      [
        state({ walletId: 'live1', mode: 'LIVE', capitalAllocated: 100, availableBalance: 250.5 }),
        state({ walletId: 'paper1', capitalAllocated: 1000, availableBalance: 900 }),
      ],
      new Map([['live1', []], ['paper1', []]]),
    );
    // 250.5 (exchange truth for the LIVE wallet) + 1000 (paper capital)
    expect(payload.totalCapital).toBeCloseTo(1250.5, 4);
  });
});

describe('dashboard NO positions price at 1 − YES mid', () => {
  const positions = [
    { marketId: 'mNO', outcome: 'NO' as const, size: 10, avgPrice: 0.6, realizedPnl: 0 },
    { marketId: 'mYES', outcome: 'YES' as const, size: 10, avgPrice: 0.3, realizedPnl: 0 },
    { marketId: 'mUnknown', outcome: 'NO' as const, size: 5, avgPrice: 0.4, realizedPnl: 0 },
  ];
  const prices = new Map<string, number>([
    ['mNO', 0.3], // YES mid 0.30 → NO price 0.70
    ['mYES', 0.3],
  ]);

  it('buildDashboardPayload marks NO at the complement price', () => {
    const payload = buildDashboardPayload(
      [state({ openPositions: positions })],
      new Map([['w1', []]]),
      prices,
    );
    const e = payload.wallets[0];
    // NO: (0.70 − 0.60) × 10 = +1.0 (the old code lied: (0.30 − 0.60) × 10 = −3.0)
    expect(e.openPositions[0].unrealizedPnl).toBeCloseTo(1.0, 4);
    // YES: (0.30 − 0.30) × 10 = 0
    expect(e.openPositions[1].unrealizedPnl).toBeCloseTo(0, 4);
    // unknown market: no live price → 0 (no fake PnL)
    expect(e.openPositions[2].unrealizedPnl).toBeCloseTo(0, 4);
    expect(e.unrealizedPnl).toBeCloseTo(1.0, 4);
  });

  it('buildWalletDetail prices NO positions and counts outcomes from SELLs', () => {
    const trades = [
      trade('BUY', -0.02, { marketId: 'mNO' }),
      trade('SELL', 1.5, { marketId: 'mNO' }),
      trade('BUY', -0.02, { marketId: 'mYES' }),
    ];
    const d = buildWalletDetail(state({ openPositions: positions }), trades, prices);
    const noPos = d.wallet.openPositions.find((p) => p.marketId === 'mNO');
    expect(noPos?.currentPrice).toBeCloseTo(0.7, 4); // 1 − 0.30, not 0.30
    expect(noPos?.unrealizedPnl).toBeCloseTo(1.0, 4);
    expect(d.stats.closedTrades).toBe(1);
    expect(d.stats.totalTrades).toBe(3);
    expect(d.stats.buyTrades).toBe(2);
    expect(d.stats.sellTrades).toBe(1);
    expect(d.stats.longestLossStreak).toBe(0); // BUY fees no longer fake a loss streak
    expect(d.stats.longestWinStreak).toBe(1);
  });
});
