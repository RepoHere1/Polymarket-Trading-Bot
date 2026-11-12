import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CopyTradeStrategy, syncTrackedWhalesIntoCopyTrade } from '../src/strategies/copy_trading/copy_trade_strategy';
import { WalletStore } from '../src/storage/wallet_store';
import { WalletState } from '../src/types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   COPY LINKS (operator control panel) + operator DELETE tombstones

   1. A copy link the operator turns OFF must stay OFF: the deny makes
      addWhaleAddress refuse the address, so the 60s whale-tracker bridge
      cannot re-enable it behind the operator's back.
   2. The deny survives "restarts" in the store (wallet_whale_denies).
   3. A config.yaml wallet deleted from the dashboard is tombstoned — boot
      must skip it (config can no longer resurrect an operator delete).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const WHALE_A = '0x' + 'ab'.repeat(20);
const WHALE_B = '0x' + 'cd'.repeat(20);
const TEST_DB = path.join(__dirname, '.test_copy_links.db');

function mkWallet(overrides: Partial<WalletState> = {}): WalletState {
  return {
    walletId: 'paper_copy_trade',
    mode: 'PAPER',
    assignedStrategy: 'copy_trade',
    capitalAllocated: 10_000,
    availableBalance: 10_000,
    openPositions: [],
    realizedPnl: 0,
    riskLimits: {
      maxPositionSize: 500,
      maxExposurePerMarket: 500,
      maxDailyLoss: 500,
      maxOpenTrades: 30,
      maxDrawdown: 0.15,
    },
    ...overrides,
  };
}

function mkInstance(): CopyTradeStrategy {
  const s = new CopyTradeStrategy();
  s.initialize({ wallet: mkWallet(), config: {} });
  return s;
}

afterEach(() => {
  try {
    if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
  } catch {
    /* ignore */
  }
});

describe('Copy links — operator OFF beats the tracker bridge', () => {
  it('denyWhaleAddress stops following immediately and blocks addWhaleAddress + the bridge', () => {
    const s = mkInstance();
    expect(s.addWhaleAddress(WHALE_A)).toBe(true);
    expect(s.getWhaleAddresses()).toEqual([WHALE_A]);

    /* Operator turns the link OFF */
    expect(s.denyWhaleAddress(WHALE_A)).toBe(true);
    expect(s.getWhaleAddresses()).toEqual([]); // stopped following NOW
    expect(s.isWhaleDenied(WHALE_A)).toBe(true);

    /* Neither a manual add nor the 60s bridge can re-enable it */
    expect(s.addWhaleAddress(WHALE_A)).toBe(false);
    expect(syncTrackedWhalesIntoCopyTrade([s], [WHALE_A, WHALE_B])).toBe(1); // only B
    expect(s.getWhaleAddresses().sort()).toEqual([WHALE_B]);

    /* Other whales are untouched by the deny */
    expect(s.isWhaleDenied(WHALE_B)).toBe(false);
  });

  it('allowWhaleAddress re-enables the link (operator ON)', () => {
    const s = mkInstance();
    s.denyWhaleAddress(WHALE_A);
    expect(s.allowWhaleAddress(WHALE_A)).toBe(true);
    expect(s.addWhaleAddress(WHALE_A)).toBe(true);
    expect(s.getWhaleAddresses()).toEqual([WHALE_A]);
    /* Clearing an empty deny is a no-op */
    expect(s.allowWhaleAddress(WHALE_A)).toBe(false);
  });
});

describe('Copy links — per-lane ADD / REMOVE (Copy Trading tab)', () => {
  it('removeWhaleAddress unwires the whale; re-adding is allowed (no sticky deny)', () => {
    const s = mkInstance();
    expect(s.addWhaleAddress(WHALE_A)).toBe(true);
    expect(s.removeWhaleAddress(WHALE_A)).toBe(true);
    expect(s.getWhaleAddresses()).toEqual([]);
    expect(s.isWhaleDenied(WHALE_A)).toBe(false);
    /* REMOVE is not a block — an operator ADD can wire the whale again */
    expect(s.addWhaleAddress(WHALE_A)).toBe(true);
    expect(s.getWhaleAddresses()).toEqual([WHALE_A]);
  });

  it('allowWhaleAddress + removeWhaleAddress fully purges an OFF link (the /api/copy-links/remove wiring)', () => {
    const s = mkInstance();
    s.denyWhaleAddress(WHALE_A);
    expect(s.allowWhaleAddress(WHALE_A)).toBe(true); // endpoint clears the deny first
    expect(s.removeWhaleAddress(WHALE_A)).toBe(false); // never followed — still ok
    expect(s.isWhaleDenied(WHALE_A)).toBe(false);
    /* The bridge is free to re-add it later: REMOVE unwires, OFF blocks */
    expect(syncTrackedWhalesIntoCopyTrade([s], [WHALE_A])).toBe(1);
    expect(s.getWhaleAddresses()).toEqual([WHALE_A]);
  });

  it('per-lane add/remove never leaks into another lane', () => {
    const a = mkInstance();
    const b = new CopyTradeStrategy();
    b.initialize({ wallet: mkWallet({ walletId: 'other_lane' }), config: {} });
    a.addWhaleAddress(WHALE_A);
    a.removeWhaleAddress(WHALE_A);
    expect(b.getWhaleAddresses()).toEqual([]);
    expect(a.addWhaleAddress(WHALE_B)).toBe(true);
    expect(b.getWhaleAddresses()).toEqual([]);
  });
});

describe('WalletStore v5 — copy-link denies + operator DELETE tombstones', () => {
  beforeEach(() => {
    try {
      if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
    } catch {
      /* ignore */
    }
  });

  it('whale denies round-trip across a store "restart"', () => {
    const store1 = new WalletStore(TEST_DB);
    store1.setWhaleDenied('paper_copy_trade', WHALE_A, true);
    store1.setWhaleDenied('paper_copy_trade', WHALE_B, true);
    store1.setWhaleDenied('live_lane_1', WHALE_A, true);
    store1.close();

    const store2 = new WalletStore(TEST_DB);
    const denies = store2.listWhaleDenies();
    expect(denies.get('paper_copy_trade')?.sort()).toEqual([WHALE_A, WHALE_B].sort());
    expect(denies.get('live_lane_1')).toEqual([WHALE_A]);

    /* Turning a link back ON removes just that row */
    store2.setWhaleDenied('paper_copy_trade', WHALE_A, false);
    expect(store2.listWhaleDenies().get('paper_copy_trade')).toEqual([WHALE_B]);
    store2.close();
  });

  it('tombstones round-trip and clear — an operator delete survives boot', () => {
    const store1 = new WalletStore(TEST_DB);
    store1.tombstoneWallet('paper_momentum');
    store1.tombstoneWallet('wallet_2');
    store1.tombstoneWallet('wallet_2'); // idempotent
    expect(store1.listTombstones().sort()).toEqual(['paper_momentum', 'wallet_2'].sort());

    /* Re-creating the id from the dashboard clears its tombstone */
    store1.clearTombstone('wallet_2');
    expect(store1.listTombstones()).toEqual(['paper_momentum']);
    store1.close();

    const store2 = new WalletStore(TEST_DB);
    expect(store2.listTombstones()).toEqual(['paper_momentum']);
    store2.close();
  });

  it('deleteWallet drops the wallet whale deny rows with it', () => {
    const store = new WalletStore(TEST_DB);
    store.setWhaleDenied('gone_lane', WHALE_A, true);
    store.setWhaleDenied('kept_lane', WHALE_B, true);
    store.deleteWallet('gone_lane');
    const denies = store.listWhaleDenies();
    expect(denies.has('gone_lane')).toBe(false);
    expect(denies.get('kept_lane')).toEqual([WHALE_B]);
    store.close();
  });
});
