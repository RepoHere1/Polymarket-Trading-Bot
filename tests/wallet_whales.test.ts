import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Engine } from '../src/core/engine';
import { OrderRouter } from '../src/execution/order_router';
import { TradeExecutor } from '../src/execution/trade_executor';
import { RiskEngine } from '../src/risk/risk_engine';
import { KillSwitch } from '../src/risk/kill_switch';
import { WalletManager } from '../src/wallets/wallet_manager';
import { WalletStore } from '../src/storage/wallet_store';
import { CopyTradeStrategy } from '../src/strategies/copy_trading/copy_trade_strategy';
import { ClobFetcher } from '../src/data/clob_fetcher';
import { AppConfig, WalletState } from '../src/types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CREATE-FORM WHALE BOX (the copy-trade truth fix)

   A copy_trade wallet created from the dashboard with real whale
   addresses must follow EXACTLY those whales from its first tick:
   - the per-wallet override wins over config.yaml's global list,
   - without an override the global config.yaml list still applies,
   - the whale list persists with the wallet across restarts (v3).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const FORM_WHALE_A = '0x' + 'ab'.repeat(20);
const FORM_WHALE_B = '0x' + 'cd'.repeat(20);
const CONFIG_WHALE = '0x' + 'ee'.repeat(20);

const TEST_DB = path.join(__dirname, '.test_wallet_whales.db');

function cleanup(): void {
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
}

afterEach(cleanup);

function baseState(id: string): WalletState {
  return {
    walletId: id,
    mode: 'PAPER',
    strategy: 'copy_trade',
    assignedStrategy: 'copy_trade',
    capitalAllocated: 500,
    availableBalance: 500,
    openPositions: [],
    realizedPnl: 0,
    riskLimits: {
      maxPositionSize: 100,
      maxExposurePerMarket: 500,
      maxDailyLoss: 100,
      maxOpenTrades: 10,
      maxDrawdown: 1,
    },
  } as WalletState;
}

function buildEngine() {
  const manager = new WalletManager();
  const config: AppConfig = {
    environment: { enableLiveTrading: false },
    wallets: [],
    strategyConfig: {
      copy_trade: { whale_addresses: [CONFIG_WHALE], poll_interval_seconds: 9999 },
    },
    polymarket: { gammaApi: 'http://gamma.test', clobApi: 'http://clob.test' },
  };
  const clobStub = { fetchOrderBook: async () => null } as unknown as ClobFetcher;
  const engine = new Engine(
    config,
    manager,
    new OrderRouter(manager, new RiskEngine(new KillSwitch()), new TradeExecutor()),
    clobStub,
  );
  return { engine, manager };
}

describe('Create-form whale box — engine wiring', () => {
  it('a wallet created with whale addresses follows them from birth (override beats config.yaml)', () => {
    const { engine, manager } = buildEngine();
    manager.registerExternalWallet('w_form', { getState: () => baseState('w_form') } as never);

    expect(engine.addRunner('w_form', 'copy_trade', { whale_addresses: [FORM_WHALE_A, FORM_WHALE_B] })).toBe(true);

    const instances = engine.getStrategiesByName('copy_trade') as CopyTradeStrategy[];
    expect(instances).toHaveLength(1);
    expect(instances[0]).toBeInstanceOf(CopyTradeStrategy);
    /* The FORM list wins — not config.yaml's CONFIG_WHALE. */
    expect(instances[0].getWhaleAddresses()).toEqual([FORM_WHALE_A, FORM_WHALE_B]);
    /* Per-whale performance trackers exist for exactly the form whales. */
    expect(instances[0].getWhalePerformance().size).toBe(2);
  });

  it('without an override the global config.yaml whale list still applies (backwards compatible)', () => {
    const { engine, manager } = buildEngine();
    manager.registerExternalWallet('w_legacy', { getState: () => baseState('w_legacy') } as never);

    expect(engine.addRunner('w_legacy', 'copy_trade')).toBe(true);
    const instances = engine.getStrategiesByName('copy_trade') as CopyTradeStrategy[];
    expect(instances[0].getWhaleAddresses()).toEqual([CONFIG_WHALE]);
  });

  it('each wallet gets its OWN whale list — no shared-array leak between lanes', () => {
    const { engine, manager } = buildEngine();
    manager.registerExternalWallet('w_a', { getState: () => baseState('w_a') } as never);
    manager.registerExternalWallet('w_b', { getState: () => baseState('w_b') } as never);

    engine.addRunner('w_a', 'copy_trade', { whale_addresses: [FORM_WHALE_A] });
    engine.addRunner('w_b', 'copy_trade', { whale_addresses: [FORM_WHALE_B] });

    const [a, b] = engine.getStrategiesByName('copy_trade') as CopyTradeStrategy[];
    expect(a.getWhaleAddresses()).toEqual([FORM_WHALE_A]);
    expect(b.getWhaleAddresses()).toEqual([FORM_WHALE_B]);
    /* Runtime adds to one lane must never leak into the other. */
    expect(a.addWhaleAddress(CONFIG_WHALE)).toBe(true);
    expect(b.getWhaleAddresses()).toEqual([FORM_WHALE_B]);
  });
});

describe('Create-form whale box — persistence (v3)', () => {
  it('whale addresses round-trip through the store with the wallet', () => {
    const store1 = new WalletStore(TEST_DB);
    store1.savePaperWallet({
      walletId: 'whale_lane_1',
      displayName: 'Whale Lane 1',
      strategy: 'copy_trade',
      capital: 500,
      balance: 500,
      realizedPnl: 0,
      openPositions: [],
      riskLimits: { maxPositionSize: 100, maxExposurePerMarket: 500, maxDailyLoss: 100, maxOpenTrades: 10, maxDrawdown: 0.2 },
      trades: [],
      paused: false,
      source: 'dashboard',
      whaleAddresses: [FORM_WHALE_A, FORM_WHALE_B],
    });
    store1.close();

    const store2 = new WalletStore(TEST_DB);
    const restored = store2.listPaperWallets();
    expect(restored).toHaveLength(1);
    expect(restored[0].whaleAddresses).toEqual([FORM_WHALE_A, FORM_WHALE_B]);
    store2.close();
  });

  it('a pre-v3 database is migrated in place (whale_addresses column added, old rows list as [])', () => {
    /* Simulate an old DB: v2 schema without the whale_addresses column. */
    const db = new Database(TEST_DB);
    db.exec(`
      CREATE TABLE paper_wallets (
        wallet_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, strategy TEXT NOT NULL,
        capital REAL NOT NULL, balance REAL NOT NULL, realized_pnl REAL NOT NULL,
        open_positions TEXT NOT NULL, risk_limits TEXT NOT NULL, trades TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'dashboard'
      );
    `);
    db.prepare(
      `INSERT INTO paper_wallets (wallet_id, display_name, strategy, capital, balance, realized_pnl,
        open_positions, risk_limits, trades, paused, updated_at, source)
       VALUES ('old_w', 'Old', 'momentum', 100, 100, 0, '[]', '{}', '[]', 0, ?, 'dashboard')`,
    ).run(Date.now());
    db.close();

    const store = new WalletStore(TEST_DB); /* constructor migrates v2 → v3 */
    const rows = store.listPaperWallets();
    expect(rows).toHaveLength(1);
    expect(rows[0].walletId).toBe('old_w');
    expect(rows[0].whaleAddresses).toEqual([]);
    store.close();
  });
});
