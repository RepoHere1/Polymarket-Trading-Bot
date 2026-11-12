/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Polywhaler Leaderboard Seeder

   VERIFIED 2026-11-11: https://polywhaler.com/api/leaderboard?page=N is a
   PUBLIC JSON endpoint returning full wallet addresses alongside verified
   quality metrics (smartMoneyScore, winRate, totalProfitLoss, totalTrades,
   isConfirmedInsider, isProvisional). ~50 entries per page, 5+ pages.

   The rendered leaderboard page shows usernames, which is why an earlier
   audit wrongly dismissed polywhaler as "not a usable seed source" — the
   API behind it exposes real 0x addresses.

   Seeded whales are upserted into whales.db with tracking_enabled=1 and a
   'polywhaler' tag; the ingestion pipeline backfills their trade history
   from the public Data API v2 and the existing 60-second
   syncTrackedWhalesIntoCopyTrade bridge feeds every copy_trade runner.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { logger } from '../reporting/logs';
import type { WhaleDB } from './whale_db';
import type { PolywhalerSeedConfig } from './whale_types';

const POLYWHALE_API = 'https://polywhaler.com/api/leaderboard';
const REQUEST_TIMEOUT_MS = 20_000;
const WALLET_RE = /^0x[0-9a-f]{40}$/;

/** One leaderboard entry from polywhaler's public API (subset of fields). */
export interface PolywhalerEntry {
  wallet: string;
  traderName: string | null;
  winRate: number;
  totalProfitLoss: number;
  recentProfitLoss: number;
  smartMoneyScore: number;
  isProvisional: boolean;
  totalTrades: number;
  isConfirmedInsider: boolean;
  rank: number;
}

interface LeaderboardResponse {
  entries?: PolywhalerEntry[];
}

/** Parse/validate one raw entry — null when it fails the shape contract. */
export function parseEntry(raw: unknown): PolywhalerEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const wallet = typeof e.wallet === 'string' ? e.wallet.toLowerCase() : '';
  if (!WALLET_RE.test(wallet)) return null;
  const score = Number(e.smartMoneyScore);
  const winRate = Number(e.winRate);
  const totalTrades = Number(e.totalTrades);
  if (!Number.isFinite(score) || !Number.isFinite(winRate) || !Number.isFinite(totalTrades)) return null;
  return {
    wallet,
    traderName: typeof e.traderName === 'string' ? e.traderName : null,
    winRate,
    totalProfitLoss: Number(e.totalProfitLoss ?? 0),
    recentProfitLoss: Number(e.recentProfitLoss ?? 0),
    smartMoneyScore: score,
    isProvisional: e.isProvisional === true,
    totalTrades,
    isConfirmedInsider: e.isConfirmedInsider === true,
    rank: Number(e.rank ?? 0),
  };
}

/** Apply the qualification filters (pure — exported for tests). */
export function qualifies(entry: PolywhalerEntry, cfg: PolywhalerSeedConfig): boolean {
  if (entry.isProvisional) return false;
  if (cfg.skipConfirmedInsiders && entry.isConfirmedInsider) return false;
  if (entry.smartMoneyScore < cfg.minScore) return false;
  if (entry.winRate < cfg.minWinRate) return false;
  if (entry.totalTrades < cfg.minTrades) return false;
  return true;
}
export class PolywhalerSeeder {
  private db: WhaleDB;
  private cfg: PolywhalerSeedConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight = false;

  constructor(db: WhaleDB, cfg: PolywhalerSeedConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  start(): void {
    if (this.running || !this.cfg.enabled) return;
    this.running = true;
    /* First seed runs in the background — never blocks service start. */
    void this.seed();
    const intervalMs = Math.max(1, this.cfg.refreshHours) * 3_600_000;
    this.timer = setInterval(() => void this.seed(), intervalMs);
    logger.info(
      { pages: this.cfg.pages, minScore: this.cfg.minScore, refreshHours: this.cfg.refreshHours },
      'PolywhalerSeeder started',
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Fetch one leaderboard page. Throws on transport/HTTP errors. */
  private async fetchPage(page: number): Promise<PolywhalerEntry[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${POLYWHALE_API}?page=${page}`, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`polywhaler leaderboard HTTP ${res.status} (page ${page})`);
      }
      const body = (await res.json()) as LeaderboardResponse;
      const entries = Array.isArray(body.entries) ? body.entries : [];
      return entries
        .map(parseEntry)
        .filter((e): e is PolywhalerEntry => e !== null);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One seeding pass: fetch pages, filter, upsert the best topK into
   * whales.db. Idempotent — whales already tracked are updated, not
   * duplicated. Returns the number of NEW whales added.
   */
  async seed(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const seen = new Set<string>();
      const collected: PolywhalerEntry[] = [];

      for (let page = 1; page <= this.cfg.pages; page++) {
        let entries: PolywhalerEntry[];
        try {
          entries = await this.fetchPage(page);
        } catch (err) {
          /* Real data or a real failure — log and stop collecting. */
          logger.warn({ err: (err as Error).message, page }, 'Polywhaler leaderboard fetch failed');
          break;
        }
        if (entries.length === 0) break;
        for (const e of entries) {
          if (!seen.has(e.wallet)) {
            seen.add(e.wallet);
            collected.push(e);
          }
        }
      }

      const qualified = collected
        .filter((e) => qualifies(e, this.cfg))
        .sort((a, b) => b.smartMoneyScore - a.smartMoneyScore)
        .slice(0, this.cfg.topK);

      let added = 0;
      for (const e of qualified) {
        const existing = this.db.getWhaleByAddress(e.wallet);
        if (!existing) added++;
        this.db.addWhale(e.wallet, {
          displayName: e.traderName ?? undefined,
          tags: [
            'polywhaler',
            `sm-${Math.round(e.smartMoneyScore)}`,
            `wr-${Math.round(e.winRate)}`,
          ],
          notes: `polywhaler rank ${e.rank} · P&L $${Math.round(e.totalProfitLoss).toLocaleString('en-US')} · ${e.totalTrades} trades`,
        });
      }

      if (added > 0) {
        logger.info(
          { added, qualified: qualified.length, scanned: collected.length, pages: this.cfg.pages },
          'Polywhaler seed: new whales tracked',
        );
      } else {
        logger.debug({ qualified: qualified.length }, 'Polywhaler seed: no new whales');
      }
      return added;
    } finally {
      this.inFlight = false;
    }
  }
}