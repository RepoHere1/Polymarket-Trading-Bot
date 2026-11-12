import { WalletState, TradeRecord } from '../types';

export interface PerformanceSnapshot {
  walletId: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  winRate: number;
  winCount: number;
  lossCount: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  sharpeLike: number;
  totalTrades: number;
  /** Closed outcomes (SELL trades). Win/loss metrics are meaningless below 1. */
  closedTrades: number;
}

export interface WalletDashboardEntry {
  walletId: string;
  displayName: string;
  mode: 'LIVE' | 'PAPER' | 'LIVE_LANE';
  strategy: string;
  capitalAllocated: number;
  availableBalance: number;
  /** LIVE only: exchange-reported USD buying power (undefined = never synced). */
  exchangeUsd?: number;
  /** LIVE only: true once the exchange answered at least one balance request. */
  exchangeSynced?: boolean;
  /** LIVE only: last exchange sync error (cleared on success). */
  exchangeError?: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  paused: boolean;
  openPositions: Array<{
    marketId: string;
    outcome: 'YES' | 'NO';
    size: number;
    avgPrice: number;
    realizedPnl: number;
    unrealizedPnl: number;
  }>;
  riskLimits: {
    maxPositionSize: number;
    maxExposurePerMarket: number;
    maxDailyLoss: number;
    maxOpenTrades: number;
    maxDrawdown: number;
  };
  performance: PerformanceSnapshot;
}

export interface DashboardPayload {
  generatedAt: string;
  totalCapital: number;
  totalPnl: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  /** Wallets whose strategy runner is attached AND not paused (the "X of Y" in the header). */
  activeWallets: number;
  /** All wallets known to the manager (running, paused, or runner-less). */
  totalWallets: number;
  wallets: WalletDashboardEntry[];
}

export function computePerformance(
  wallet: WalletState,
  trades: TradeRecord[],
  unrealizedPnl: number,
): PerformanceSnapshot {
  /* Outcome metrics come from SELL trades only. A BUY's realized PnL is just
     its fee (always ≤ 0) — counting buys as "losses" made holding wallets
     report 0W/30L while actually being up. Open positions are not outcomes. */
  const sells = trades.filter((t) => t.side === 'SELL');
  const wins = sells.filter((t) => t.realizedPnl > 0);
  const losses = sells.filter((t) => t.realizedPnl < 0);
  const closedTrades = sells.length;
  const winRate = closedTrades > 0 ? wins.length / closedTrades : 0;

  const totalWinPnl = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const totalLossPnl = losses.reduce((s, t) => s + t.realizedPnl, 0);
  const avgWin = wins.length > 0 ? totalWinPnl / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLossPnl / losses.length : 0;
  const profitFactor =
    losses.length > 0 && totalLossPnl !== 0
      ? Math.abs(totalWinPnl / totalLossPnl)
      : wins.length > 0
        ? Infinity
        : 0;

  // Sharpe-like ratio: PnL / capital
  const totalPnl = wallet.realizedPnl + unrealizedPnl;
  const sharpeLike = Number(
    (totalPnl / Math.max(1, wallet.capitalAllocated)).toFixed(4),
  );

  return {
    walletId: wallet.walletId,
    realizedPnl: wallet.realizedPnl,
    unrealizedPnl,
    totalPnl,
    winRate: Number(winRate.toFixed(4)),
    winCount: wins.length,
    lossCount: losses.length,
    avgWin: Number(avgWin.toFixed(4)),
    avgLoss: Number(avgLoss.toFixed(4)),
    profitFactor: profitFactor === Infinity ? 999 : Number(profitFactor.toFixed(4)),
    sharpeLike,
    totalTrades: trades.length,
    closedTrades,
  };
}

export function buildDashboardPayload(
  wallets: WalletState[],
  tradesByWallet: Map<string, TradeRecord[]>,
  marketPrices?: Map<string, number>,
  pausedWallets?: Set<string>,
  displayNames?: Map<string, string>,
  /** Wallets whose runner is attached and NOT paused — omitted → every wallet counts. */
  runningWalletIds?: Set<string>,
): DashboardPayload {
  /* marketPrices maps marketId → YES mid. A NO share's price is 1 − yesMid
     (binary complement). Pricing NO shares with the YES mid inverted PnL. */
  const priceOf = (marketId: string, outcome: 'YES' | 'NO'): number | undefined => {
    const yesMid = marketPrices?.get(marketId);
    if (yesMid === undefined) return undefined;
    return outcome === 'YES' ? yesMid : 1 - yesMid;
  };

  const entries: WalletDashboardEntry[] = wallets.map((w) => {
    const trades = tradesByWallet.get(w.walletId) ?? [];

    // Compute unrealized PnL for each open position (skip zero-size)
    let walletUnrealizedPnl = 0;
    const positions = w.openPositions.filter((p) => p.size > 0).map((p) => {
      // Use the live outcome price if available, otherwise avgPrice (no unrealized PnL)
      const currentPrice = priceOf(p.marketId, p.outcome) ?? p.avgPrice;
      const unrealizedPnl =
        p.size > 0 && p.avgPrice > 0
          ? (currentPrice - p.avgPrice) * p.size
          : 0;
      walletUnrealizedPnl += unrealizedPnl;
      return {
        marketId: p.marketId,
        outcome: p.outcome,
        size: Number(p.size.toFixed(4)),
        avgPrice: Number(p.avgPrice.toFixed(4)),
        realizedPnl: Number(p.realizedPnl.toFixed(4)),
        unrealizedPnl: Number(unrealizedPnl.toFixed(4)),
      };
    });

    return {
      walletId: w.walletId,
      displayName: displayNames?.get(w.walletId) ?? w.walletId,
      mode: w.mode,
      strategy: w.assignedStrategy,
      capitalAllocated: w.capitalAllocated,
      availableBalance: Number(w.availableBalance.toFixed(4)),
      exchangeUsd: w.exchangeUsd,
      exchangeSynced: w.exchangeSynced,
      exchangeError: w.exchangeError,
      realizedPnl: Number(w.realizedPnl.toFixed(4)),
      unrealizedPnl: Number(walletUnrealizedPnl.toFixed(4)),
      totalPnl: Number((w.realizedPnl + walletUnrealizedPnl).toFixed(4)),
      paused: pausedWallets?.has(w.walletId) ?? false,
      openPositions: positions,
      riskLimits: w.riskLimits,
      performance: computePerformance(w, trades, walletUnrealizedPnl),
    };
  });

  const totalRealizedPnl = entries.reduce((s, e) => s + e.realizedPnl, 0);
  const totalUnrealizedPnl = entries.reduce((s, e) => s + e.unrealizedPnl, 0);

  /* LIVE capital is exchange truth (availableBalance, refreshed from the
     exchange), not the configured number. LIVE_LANE keeps its budget — a lane
     can never spend past it even if the shared account holds more. */
  const totalCapital = entries.reduce(
    (s, e) => s + (e.mode === 'LIVE' ? e.availableBalance : e.capitalAllocated),
    0,
  );

  return {
    generatedAt: new Date().toISOString(),
    totalCapital,
    totalPnl: Number((totalRealizedPnl + totalUnrealizedPnl).toFixed(4)),
    totalRealizedPnl: Number(totalRealizedPnl.toFixed(4)),
    totalUnrealizedPnl: Number(totalUnrealizedPnl.toFixed(4)),
    activeWallets: runningWalletIds
      ? entries.filter((e) => runningWalletIds.has(e.walletId)).length
      : entries.length,
    totalWallets: entries.length,
    wallets: entries,
  };
}
