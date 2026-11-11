import { describe, it, expect } from 'vitest';
import { Engine } from '../src/core/engine';
import { OrderRouter } from '../src/execution/order_router';
import { TradeExecutor } from '../src/execution/trade_executor';
import { RiskEngine } from '../src/risk/risk_engine';
import { KillSwitch } from '../src/risk/kill_switch';
import { WalletManager } from '../src/wallets/wallet_manager';
import { CopyTradeStrategy } from '../src/strategies/copy_trading/copy_trade_strategy';
import type { StrategyInterface } from '../src/strategies/strategy_interface';
import { ClobFetcher } from '../src/data/clob_fetcher';
import { AppConfig, MarketData, WalletState } from '../src/types';

/* ━━━━━━━━━━━━━━ OPERATOR LAW TESTS ━━━━━━━━━━━━━━
   The owner's dashboard buttons are the only authority over lane state:
   - a lane the operator paused never trades,
   - a crashing strategy can never take other lanes down,
   - the operator's START clears software self-stops.            */

function spyStrategy(name: string, opts: { throwOnTimer?: boolean; throwOnUpdate?: boolean } = {}) {
  const counts = { timer: 0, update: 0, resume: 0 };
  const strategy: StrategyInterface = {
    name,
    initialize() {},
    onMarketUpdate() {
      counts.update++;
      if (opts.throwOnUpdate) throw new Error('update boom');
    },
    onTimer() {
      counts.timer++;
      if (opts.throwOnTimer) throw new Error('tick boom');
    },
    generateSignals: () => [],
    sizePositions: () => [],
    submitOrders() {},
    notifyFill() {},
    managePositions() {},
    drainExitOrders: () => [],
    shutdown() {},
    onOperatorResume() {
      counts.resume++;
    },
  };
  return { strategy, counts };
}

function baseState(id: string): WalletState {
  return {
    walletId: id,
    mode: 'PAPER',
    strategy: 'stub',
    assignedStrategy: 'stub',
    capitalAllocated: 1000,
    availableBalance: 1000,
    openPositions: [],
    realizedPnl: 0,
    riskLimits: {
      maxPositionSize: 1000,
      maxExposurePerMarket: 10000,
      maxDailyLoss: 1000,
      maxOpenTrades: 10,
      maxDrawdown: 1,
    },
  } as WalletState;
}

function buildEngine(runnerSpecs: { id: string; strategy: StrategyInterface }[]) {
  const manager = new WalletManager();
  const config: AppConfig = {
    environment: { enableLiveTrading: false },
    wallets: [],
    strategyConfig: {},
    polymarket: { gammaApi: 'http://gamma.test', clobApi: 'http://clob.test' },
  };
  const clobStub = { fetchOrderBook: async () => null } as unknown as ClobFetcher;
  const engine = new Engine(
    config,
    manager,
    new OrderRouter(manager, new RiskEngine(new KillSwitch()), new TradeExecutor()),
    clobStub,
  );
  const internals = engine as unknown as {
    runners: unknown[];
    tick(): Promise<void>;
    handleMarketUpdate(d: MarketData): void;
  };
  for (const spec of runnerSpecs) {
    internals.runners.push({ strategy: spec.strategy, walletId: spec.id, config: {} });
  }
  return { engine, internals };
}

function marketData(): MarketData {
  return {
    marketId: 'mkt-1',
    question: 'Test market?',
    slug: 'test-market',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.5, 0.5],
    clobTokenIds: ['tok-yes', 'tok-no'],
    midPrice: 0.5,
    bid: 0.49,
    ask: 0.51,
    spread: 0.02,
    volume24h: 1000,
    liquidity: 5000,
    timestamp: Date.now(),
  } as MarketData;
}

describe('OPERATOR LAW: lane sovereignty', () => {
  it('a crashing runner is isolated — the lanes below it keep ticking', async () => {
    const bad = spyStrategy('bad', { throwOnTimer: true });
    const good = spyStrategy('good');
    const { internals } = buildEngine([
      { id: 'wa', strategy: bad.strategy },
      { id: 'wb', strategy: good.strategy },
    ]);

    await expect(internals.tick()).resolves.toBeUndefined();

    expect(bad.counts.timer).toBe(1); // it did run (and threw)
    expect(good.counts.timer).toBe(1); // NOT starved by the crash above it
  });

  it('a strategy that throws in onMarketUpdate does not block data for other lanes', () => {
    const bad = spyStrategy('bad', { throwOnUpdate: true });
    const good = spyStrategy('good');
    const { internals } = buildEngine([
      { id: 'wa', strategy: bad.strategy },
      { id: 'wb', strategy: good.strategy },
    ]);

    expect(() => internals.handleMarketUpdate(marketData())).not.toThrow();
    expect(good.counts.update).toBe(1);
  });

  it('a lane the operator paused never trades (no timer, no signals)', async () => {
    const s = spyStrategy('momentum');
    const { engine, internals } = buildEngine([{ id: 'w1', strategy: s.strategy }]);

    expect(engine.pauseRunner('w1')).toBe(true);
    await internals.tick();

    expect(s.counts.timer).toBe(0); // frozen by operator law
  });

  it("the operator's START (resume) fires onOperatorResume — software self-stops yield", async () => {
    const s = spyStrategy('copy_trade');
    const { engine, internals } = buildEngine([{ id: 'w1', strategy: s.strategy }]);

    engine.pauseRunner('w1');
    expect(engine.resumeRunner('w1')).toBe(true);
    expect(s.counts.resume).toBe(1); // self-stop clear hook ran

    await internals.tick();
    expect(s.counts.timer).toBe(1); // lane trades again immediately
  });

  it('copy_trade: operator resume clears the drawdown breaker and whale cooldowns', () => {
    const s = new CopyTradeStrategy();
    s.initialize({
      wallet: baseState('wct'),
      config: { whale_addresses: ['0xaaaa'], poll_interval_seconds: 9999, max_drawdown_pct: 0.5 },
    });

    const internals = s as unknown as {
      drawdownPaused: boolean;
      whalePerf: Map<string, { pausedUntil: number; consecutiveLosses: number }>;
    };
    internals.drawdownPaused = true;
    const perf = internals.whalePerf.get('0xaaaa');
    expect(perf).toBeDefined();
    perf!.pausedUntil = Date.now() + 999_999;
    perf!.consecutiveLosses = 3;

    s.onOperatorResume();

    expect(s.getStats().drawdownPaused).toBe(false);
    expect(perf!.pausedUntil).toBe(0);
    expect(perf!.consecutiveLosses).toBe(0);
  });
});
