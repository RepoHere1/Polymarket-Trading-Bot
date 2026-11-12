import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { WhaleDB } from '../src/whales/whale_db';
import { PolywhalerSeeder, parseEntry, qualifies, type PolywhalerEntry } from '../src/whales/polywhaler_seeder';
import { DEFAULT_POLYWHALE_SEED, type PolywhalerSeedConfig } from '../src/whales/whale_types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PolywhalerSeeder — seeds the tracker from polywhaler.com's public
   leaderboard API (verified 2026-11-11: full 0x addresses + scores).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const TEST_DB_PATH = path.join(__dirname, '.test_polywhaler.db');

const GOOD_ADDR_A = '0x1111111111111111111111111111111111111111';
const GOOD_ADDR_B = '0x2222222222222222222222222222222222222222';

function entry(overrides: Partial<PolywhalerEntry> = {}): PolywhalerEntry {
  return {
    wallet: GOOD_ADDR_A,
    traderName: 'vinii',
    winRate: 72.7,
    totalProfitLoss: 180_000,
    recentProfitLoss: 102_000,
    smartMoneyScore: 84.4,
    isProvisional: false,
    totalTrades: 155,
    isConfirmedInsider: false,
    rank: 1,
    ...overrides,
  };
}

let db: WhaleDB;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = new WhaleDB(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  vi.unstubAllGlobals();
});

function okPage(entries: unknown[]) {
  return { ok: true, status: 200, json: () => Promise.resolve({ entries }) };
}

describe('parseEntry', () => {
  it('accepts valid leaderboard rows and normalises the wallet to lowercase', () => {
    const e = parseEntry({ ...entry(), wallet: GOOD_ADDR_A.toUpperCase() });
    expect(e).not.toBeNull();
    expect(e!.wallet).toBe(GOOD_ADDR_A);
    expect(e!.traderName).toBe('vinii');
  });

  it('rejects usernames, junk wallets and non-numeric scores', () => {
    expect(parseEntry({ ...entry(), wallet: 'vinii' })).toBeNull();
    expect(parseEntry({ ...entry(), wallet: '0x123' })).toBeNull();
    expect(parseEntry({ ...entry(), smartMoneyScore: 'n/a' })).toBeNull();
    expect(parseEntry(null)).toBeNull();
  });
});

describe('qualifies', () => {
  const cfg: PolywhalerSeedConfig = { ...DEFAULT_POLYWHALE_SEED };

  it('accepts a solid whale', () => {
    expect(qualifies(entry(), cfg)).toBe(true);
  });

  it('rejects provisional entries, insiders, low score/win-rate/trades', () => {
    expect(qualifies(entry({ isProvisional: true }), cfg)).toBe(false);
    expect(qualifies(entry({ isConfirmedInsider: true }), cfg)).toBe(false);
    expect(qualifies(entry({ smartMoneyScore: 65 }), cfg)).toBe(false);
    expect(qualifies(entry({ winRate: 40 }), cfg)).toBe(false);
    expect(qualifies(entry({ totalTrades: 5 }), cfg)).toBe(false);
  });

  it('keeps insiders when skipConfirmedInsiders is false', () => {
    expect(qualifies(entry({ isConfirmedInsider: true }), { ...cfg, skipConfirmedInsiders: false })).toBe(true);
  });
});

describe('PolywhalerSeeder.seed', () => {
  it('upserts only qualifying whales, best scores first, capped at topK', async () => {
    const page = [
      entry({ wallet: GOOD_ADDR_A, smartMoneyScore: 84 }),
      entry({ wallet: GOOD_ADDR_B, smartMoneyScore: 71 }),
      { ...entry({ wallet: '0x3333333333333333333333333333333333333333', smartMoneyScore: 69 }) }, // below minScore
      { ...entry({ wallet: 'not-a-wallet', smartMoneyScore: 95 }) }, // junk — dropped by parse
    ];
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(okPage(page))
      .mockResolvedValueOnce(okPage([]))); // page 2 empty

    const seeder = new PolywhalerSeeder(db, { ...DEFAULT_POLYWHALE_SEED, pages: 2, topK: 1 });
    const added = await seeder.seed();
    expect(added).toBe(1); // topK=1 → only the best (GOOD_ADDR_A)

    const { whales, total } = db.listWhales({ limit: 100 });
    expect(total).toBe(1);
    expect(whales[0].address).toBe(GOOD_ADDR_A);
    expect(whales[0].displayName).toBe('vinii');
    expect(whales[0].tags).toContain('polywhaler');
    expect(whales[0].trackingEnabled).toBe(true);
  });

  it('is idempotent — a second pass adds nothing and updates instead', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okPage([entry({ wallet: GOOD_ADDR_A })])));
    const seeder = new PolywhalerSeeder(db, { ...DEFAULT_POLYWHALE_SEED, pages: 1 });

    expect(await seeder.seed()).toBe(1);
    expect(await seeder.seed()).toBe(0); // upsert, no duplicate

    const { total } = db.listWhales({ limit: 100 });
    expect(total).toBe(1);
  });

  it('stops collecting on fetch failure and seeds nothing when nothing was fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) }));
    const seeder = new PolywhalerSeeder(db, { ...DEFAULT_POLYWHALE_SEED, pages: 2 });
    expect(await seeder.seed()).toBe(0);
    const { total } = db.listWhales({ limit: 100 });
    expect(total).toBe(0);
  });
});
