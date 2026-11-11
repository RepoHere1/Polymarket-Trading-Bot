import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { WalletStore } from '../src/storage/wallet_store';
import { PaperWallet } from '../src/wallets/paper_wallet';
import { WalletManager } from '../src/wallets/wallet_manager';
import { RiskLimits, TradeRecord, WalletConfig } from '../src/types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Regression: dashboard-created wallets lived only in WalletManager's
   in-memory Map — a bot restart silently deleted every wallet made from
   the UI (the 5 PolyFake wallets). WalletStore + restoreState make
   PAPER wallets durable across restarts.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const TEST_DB = path.join(__dirname, '.test_wallet_store.db');

function cleanup(): void {
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
}

afterEach(cleanup);

const riskLimits: RiskLimits = {
  maxPositionSize: 200,
  maxExposurePerMarket: 300,
  maxDailyLoss: 100,
  maxOpenTrades: 10,
  maxDrawdown: 0.2,
};

function trade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    orderId: 'paper-w-1-1',
    walletId: 'PolyFake_1',
    marketId: 'mkt-1',
    outcome: 'NO',
    side: 'BUY',
    price: 0.6,
    size: 20,
    cost: 12,
    fee: 0.01,
    feeAsset: 'USDC',
    realizedPnl: -0.01,
    cumulativePnl: -0.01,
    balanceAfter: 988,
    timestamp: Date.parse('2026-11-09T12:00:00Z'),
    ...overrides,
  };
}

describe('WalletStore — PAPER wallet persistence', () => {
  it('saved wallets survive a store restart (the PolyFake scenario)', () => {
    const store1 = new WalletStore(TEST_DB);
    store1.savePaperWallet({
      walletId: 'PolyFake_1',
      displayName: 'PolyFake 1',
      strategy: 'momentum',
      capital: 1000,
      balance: 850.25,
      realizedPnl: -12.5,
      openPositions: [{ marketId: 'mkt-1', outcome: 'NO', size: 20, avgPrice: 0.6, realizedPnl: 0 }],
      riskLimits,
      trades: [trade()],
      paused: true,
    });
    store1.close();

    // "Restart": a brand-new store instance on the same file
    const store2 = new WalletStore(TEST_DB);
    const restored = store2.listPaperWallets();
    expect(restored.length).toBe(1);
    expect(restored[0].walletId).toBe('PolyFake_1');
    expect(restored[0].displayName).toBe('PolyFake 1');
    expect(restored[0].strategy).toBe('momentum');
    expect(restored[0].balance).toBe(850.25);
    expect(restored[0].realizedPnl).toBe(-12.5);
    expect(restored[0].openPositions).toEqual([
      { marketId: 'mkt-1', outcome: 'NO', size: 20, avgPrice: 0.6, realizedPnl: 0 },
    ]);
    expect(restored[0].riskLimits).toEqual(riskLimits);
    expect(restored[0].trades).toEqual([trade()]);
    expect(restored[0].paused).toBe(true);
    store2.close();
  });

  it('upsert overwrites the previous snapshot (single row per wallet)', () => {
    const store = new WalletStore(TEST_DB);
    const base = {
      walletId: 'w1',
      displayName: 'W1',
      strategy: 'momentum',
      capital: 500,
      realizedPnl: 0,
      openPositions: [],
      riskLimits,
      trades: [] as TradeRecord[],
      paused: false,
    };
    store.savePaperWallet({ ...base, balance: 500 });
    store.savePaperWallet({ ...base, balance: 432.1, displayName: 'Renamed' });

    const rows = store.listPaperWallets();
    expect(rows.length).toBe(1);
    expect(rows[0].balance).toBe(432.1);
    expect(rows[0].displayName).toBe('Renamed');
    store.close();
  });

  it('deleteWallet removes the row — deleting from the dashboard is forever', () => {
    const store = new WalletStore(TEST_DB);
    store.savePaperWallet({
      walletId: 'gone',
      displayName: 'gone',
      strategy: 'momentum',
      capital: 100,
      balance: 100,
      realizedPnl: 0,
      openPositions: [],
      riskLimits,
      trades: [],
      paused: false,
    });
    store.deleteWallet('gone');
    expect(store.listPaperWallets().length).toBe(0);
    store.close();
  });
});

describe('PaperWallet — snapshot restore + persistence hook', () => {
  const config: WalletConfig = { id: 'PolyFake_1', mode: 'PAPER', strategy: 'momentum', capital: 1000 };

  it('restoreState brings back balance, positions, PnL, trades and name', () => {
    const w = new PaperWallet(config, 'momentum');
    w.restoreState({
      balance: 850.25,
      realizedPnl: -12.5,
      openPositions: [{ marketId: 'mkt-1', outcome: 'NO', size: 20, avgPrice: 0.6, realizedPnl: 0 }],
      riskLimits,
      trades: [trade()],
      displayName: 'PolyFake 1',
    });

    const s = w.getState();
    expect(s.availableBalance).toBe(850.25);
    expect(s.realizedPnl).toBe(-12.5);
    expect(s.openPositions).toEqual([{ marketId: 'mkt-1', outcome: 'NO', size: 20, avgPrice: 0.6, realizedPnl: 0 }]);
    expect(s.riskLimits).toEqual(riskLimits);
    expect(w.getTradeHistory()).toEqual([trade()]);
    expect(w.getDisplayName()).toBe('PolyFake 1');

    // Post-restore mutations build on the restored base, not a reset
    w.setBalance(42);
    expect(w.getState().availableBalance).toBe(42);
    expect(w.getTradeHistory().length).toBe(1);
  });

  it('fires the persistence hook on every mutation', () => {
    const w = new PaperWallet(config, 'momentum');
    let calls = 0;
    w.attachPersistence(() => { calls++; });

    w.setBalance(100);           // dashboard balance override
    w.updateBalance(-5);         // engine cash adjustment
    w.setDisplayName('Renamed'); // dashboard rename

    expect(calls).toBe(3);
    expect(w.getState().availableBalance).toBe(95);
    expect(w.getDisplayName()).toBe('Renamed');
  });

  it('full restart round-trip: manager → store → new manager → identical wallet', () => {
    // Session 1: wallet created on a manager, mutates, persists via the hook
    const manager1 = new WalletManager();
    const store1 = new WalletStore(TEST_DB);
    const w1 = manager1.createPaperWallet({ ...config, riskLimits }, 'momentum');
    manager1.addWallet(w1);
    const persist = () => {
      const s = w1.getState();
      store1.savePaperWallet({
        walletId: s.walletId,
        displayName: w1.getDisplayName(),
        strategy: s.assignedStrategy,
        capital: s.capitalAllocated,
        balance: s.availableBalance,
        realizedPnl: s.realizedPnl,
        openPositions: s.openPositions,
        riskLimits: s.riskLimits,
        trades: w1.getTradeHistory(),
        paused: false,
      });
    };
    w1.attachPersistence(persist);
    persist(); // initial save (mirrors dashboard create)
    w1.setBalance(777.5);
    w1.setDisplayName('PolyFake 1');
    store1.close();

    // Session 2: fresh manager + store — the wallet must come back
    const manager2 = new WalletManager();
    const store2 = new WalletStore(TEST_DB);
    const persisted = store2.listPaperWallets();
    expect(persisted.length).toBe(1);
    const p = persisted[0];
    const w2 = manager2.createPaperWallet(
      { id: p.walletId, mode: 'PAPER', strategy: p.strategy, capital: p.capital, riskLimits: p.riskLimits },
      p.strategy,
    );
    w2.restoreState({
      balance: p.balance,
      realizedPnl: p.realizedPnl,
      openPositions: p.openPositions,
      riskLimits: p.riskLimits,
      trades: p.trades,
      displayName: p.displayName,
    });
    manager2.addWallet(w2);

    const before = w1.getState();
    const after = w2.getState();
    expect(after.walletId).toBe(before.walletId);
    expect(after.availableBalance).toBe(777.5);
    expect(after.availableBalance).toBe(before.availableBalance);
    expect(after.realizedPnl).toBe(before.realizedPnl);
    expect(after.openPositions).toEqual(before.openPositions);
    expect(w2.getDisplayName()).toBe('PolyFake 1');
    expect(w2.getTradeHistory()).toEqual(w1.getTradeHistory());
    store2.close();
  });
});