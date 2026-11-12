/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Wallet Persistence — SQLite store for dashboard-created PAPER wallets
   Uses better-sqlite3 (synchronous, production-grade), same pattern as whale_db.

   Dashboard wallets used to live only in WalletManager's in-memory Map, so a
   restart silently deleted every wallet made from the UI. This store makes
   them durable: full state (balance, positions, realised PnL, trades,
   display name, paused flag) is snapshotted on every mutation and rehydrated
   on boot.

   LIVE / LIVE_LANE wallets: since v4 the RECORD is persisted when the wallet
   runs on the server's .env polyUSA credentials - but NEVER any credential
   material (no API key, no secret; rule: credentials never touch disk).
   On boot, an armed server (ENABLE_LIVE_TRADING=true) re-wires the wallet
   through the .env client factory, so one LIVE wallet survives restarts.
   Imported-credential LIVE wallets remain in-memory only (their secret
   cannot and must not be stored), and restore of env-backed wallets is
   skipped with a warning when the server is not armed.
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { RiskLimits, TradeRecord, WalletState } from '../types';

/** Everything needed to bring a PAPER wallet back exactly as it was. */
export interface PersistedPaperWallet {
  walletId: string;
  displayName: string;
  strategy: string;
  capital: number;
  balance: number;
  realizedPnl: number;
  openPositions: WalletState['openPositions'];
  riskLimits: RiskLimits;
  trades: TradeRecord[];
  paused: boolean;
  /**
   * Per-wallet copy_trade whale addresses entered at creation (v3 column).
   * Empty/undefined for non-copy_trade wallets. Persisted so the operator's
   * whale list survives restarts with the wallet.
   */
  whaleAddresses?: string[];
  /**
   * Wallet mode (v4 column). 'PAPER' for all pre-v4 rows (default). LIVE and
   * LIVE_LANE rows exist ONLY for wallets that run on the server's .env
   * polyUSA credentials — the row stores the wallet record, never secrets.
   * Restored on boot only when the server is armed (ENABLE_LIVE_TRADING).
   */
  mode?: 'PAPER' | 'LIVE' | 'LIVE_LANE';
  /** For LIVE_LANE rows: the parent LIVE account wallet id. */
  parentWalletId?: string;
  /**
   * Where the row came from — decides restore semantics:
   * - 'dashboard': wallet born in the UI → FULL state is restored on boot and
   *   the wallet is recreated if missing (created once, stays forever).
   * - 'config': config.yaml wallet → only the operator's pause choice is
   *   restored; the row can NEVER resurrect a wallet removed from config.yaml.
   */
  source: 'dashboard' | 'config';
}

export class WalletStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_wallets (
        wallet_id      TEXT PRIMARY KEY,
        display_name   TEXT    NOT NULL,
        strategy       TEXT    NOT NULL,
        capital        REAL    NOT NULL,
        balance        REAL    NOT NULL,
        realized_pnl   REAL    NOT NULL,
        open_positions TEXT    NOT NULL,
        risk_limits    TEXT    NOT NULL,
        trades         TEXT    NOT NULL,
        paused         INTEGER NOT NULL DEFAULT 0,
        updated_at     INTEGER NOT NULL,
        source         TEXT    NOT NULL DEFAULT 'dashboard'
      );
    `);
    /* v2 migration — older DBs have no `source` column. Every pre-source row
       was a pause/balance snapshot of a config.yaml wallet, so they migrate
       as 'config' (pause-flag only, never resurrected). */
    const cols = this.db.prepare('PRAGMA table_info(paper_wallets)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'source')) {
      this.db.exec("ALTER TABLE paper_wallets ADD COLUMN source TEXT NOT NULL DEFAULT 'config'");
    }
    /* v3 migration — per-wallet copy_trade whale addresses (JSON array, NULL
        for wallets without whales). */
    const cols3 = this.db.prepare('PRAGMA table_info(paper_wallets)').all() as Array<{ name: string }>;
    if (!cols3.some((c) => c.name === 'whale_addresses')) {
      this.db.exec('ALTER TABLE paper_wallets ADD COLUMN whale_addresses TEXT');
    }
    /* v4 migration - wallet mode + LIVE lane parent. LIVE / LIVE_LANE rows
       are written only for env-credential wallets and never contain
       secrets; they let one LIVE wallet survive restarts on an armed
       server. Old rows default to PAPER (previous behaviour). */
    const cols4 = this.db.prepare('PRAGMA table_info(paper_wallets)').all() as Array<{ name: string }>;
    if (!cols4.some((c) => c.name === 'mode')) {
      this.db.exec("ALTER TABLE paper_wallets ADD COLUMN mode TEXT NOT NULL DEFAULT 'PAPER'");
    }
    if (!cols4.some((c) => c.name === 'parent_wallet_id')) {
      this.db.exec('ALTER TABLE paper_wallets ADD COLUMN parent_wallet_id TEXT');
    }
    /* v5 — operator DELETE tombstones (a config.yaml wallet deleted from the
       dashboard must NEVER resurrect on boot; the owner's DELETE is law) and
       per-lane whale deny lists (copy links the operator turned OFF — the
       60s tracker bridge refuses to re-add them). */
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deleted_wallet_ids (
        wallet_id  TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_whale_denies (
        wallet_id  TEXT NOT NULL,
        address    TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (wallet_id, address)
      );
    `);
  }

  savePaperWallet(w: PersistedPaperWallet): void {
    this.db.prepare(`
      INSERT INTO paper_wallets
        (wallet_id, display_name, strategy, capital, balance, realized_pnl,
         open_positions, risk_limits, trades, paused, updated_at, source, whale_addresses, mode, parent_wallet_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_id) DO UPDATE SET
        display_name   = excluded.display_name,
        strategy       = excluded.strategy,
        capital        = excluded.capital,
        balance        = excluded.balance,
        realized_pnl   = excluded.realized_pnl,
        open_positions = excluded.open_positions,
        risk_limits    = excluded.risk_limits,
        trades         = excluded.trades,
        paused         = excluded.paused,
        updated_at     = excluded.updated_at,
        source         = excluded.source,
        whale_addresses = excluded.whale_addresses,
        mode           = excluded.mode,
        parent_wallet_id = excluded.parent_wallet_id
    `).run(
      w.walletId,
      w.displayName,
      w.strategy,
      w.capital,
      w.balance,
      w.realizedPnl,
      JSON.stringify(w.openPositions),
      JSON.stringify(w.riskLimits),
      JSON.stringify(w.trades),
      w.paused ? 1 : 0,
      Date.now(),
      w.source,
      w.whaleAddresses && w.whaleAddresses.length > 0 ? JSON.stringify(w.whaleAddresses) : null,
      w.mode ?? 'PAPER',
      w.mode === 'LIVE_LANE' ? (w.parentWalletId ?? null) : null,
    );
  }

  deleteWallet(walletId: string): void {
    this.db.prepare('DELETE FROM paper_wallets WHERE wallet_id = ?').run(walletId);
    /* A deleted wallet's copy-link deny list is meaningless — drop it. */
    this.clearWhaleDenies(walletId);
  }

  /* ━━ Operator DELETE tombstones (v5) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     The dashboard DELETE button removes a config.yaml wallet from the running
     engine, but boot used to recreate every config.yaml entry — the owner's
     delete was silently undone on every restart. A tombstone makes the
     operator's DELETE outrank config.yaml at boot. Re-creating the same id
     from the dashboard clears the tombstone. */

  tombstoneWallet(walletId: string): void {
    this.db
      .prepare(
        `INSERT INTO deleted_wallet_ids (wallet_id, deleted_at) VALUES (?, ?)
         ON CONFLICT(wallet_id) DO NOTHING`,
      )
      .run(walletId, Date.now());
  }

  clearTombstone(walletId: string): void {
    this.db.prepare('DELETE FROM deleted_wallet_ids WHERE wallet_id = ?').run(walletId);
  }

  listTombstones(): string[] {
    const rows = this.db.prepare('SELECT wallet_id FROM deleted_wallet_ids').all() as Array<{
      wallet_id: string;
    }>;
    return rows.map((r) => r.wallet_id);
  }

  /* ━━ Per-lane whale deny lists (v5) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Copy links the operator turned OFF from the dashboard. The strategy's
     addWhaleAddress refuses denied addresses, so the whale-tracker bridge
     cannot re-enable them behind the operator's back. */

  setWhaleDenied(walletId: string, address: string, denied: boolean): void {
    if (denied) {
      this.db
        .prepare(
          `INSERT INTO wallet_whale_denies (wallet_id, address, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(wallet_id, address) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(walletId, address, Date.now());
    } else {
      this.db
        .prepare('DELETE FROM wallet_whale_denies WHERE wallet_id = ? AND address = ?')
        .run(walletId, address);
    }
  }

  listWhaleDenies(): Map<string, string[]> {
    const rows = this.db.prepare('SELECT wallet_id, address FROM wallet_whale_denies').all() as Array<{
      wallet_id: string;
      address: string;
    }>;
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const cur = out.get(r.wallet_id) ?? [];
      cur.push(r.address);
      out.set(r.wallet_id, cur);
    }
    return out;
  }

  clearWhaleDenies(walletId: string): void {
    this.db.prepare('DELETE FROM wallet_whale_denies WHERE wallet_id = ?').run(walletId);
  }

  listPaperWallets(): PersistedPaperWallet[] {
    const rows = this.db
      .prepare('SELECT * FROM paper_wallets ORDER BY updated_at ASC')
      .all() as Array<{
        wallet_id: string;
        display_name: string;
        strategy: string;
        capital: number;
        balance: number;
        realized_pnl: number;
        open_positions: string;
        risk_limits: string;
        trades: string;
        paused: number;
        source: string;
        whale_addresses: string | null;
        mode: string;
        parent_wallet_id: string | null;
      }>;
    return rows.map((r) => ({
      walletId: r.wallet_id,
      displayName: r.display_name,
      strategy: r.strategy,
      capital: r.capital,
      balance: r.balance,
      realizedPnl: r.realized_pnl,
      openPositions: JSON.parse(r.open_positions) as WalletState['openPositions'],
      riskLimits: JSON.parse(r.risk_limits) as RiskLimits,
      trades: JSON.parse(r.trades) as TradeRecord[],
      paused: r.paused === 1,
      source: r.source === 'dashboard' ? 'dashboard' : 'config',
      whaleAddresses: r.whale_addresses ? (JSON.parse(r.whale_addresses) as string[]) : [],
      mode: r.mode === 'LIVE' || r.mode === 'LIVE_LANE' ? r.mode : 'PAPER',
      parentWalletId: r.parent_wallet_id ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}
