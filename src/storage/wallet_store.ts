/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Wallet Persistence — SQLite store for dashboard-created PAPER wallets
   Uses better-sqlite3 (synchronous, production-grade), same pattern as whale_db.

   Dashboard wallets used to live only in WalletManager's in-memory Map, so a
   restart silently deleted every wallet made from the UI. This store makes
   them durable: full state (balance, positions, realised PnL, trades,
   display name, paused flag) is snapshotted on every mutation and rehydrated
   on boot.

   LIVE / LIVE_LANE wallets are intentionally NOT persisted — their polyUSA
   credentials live in memory by design and must never be written to disk;
   rehydrating them from .env could silently trade a different account.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

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
  }

  savePaperWallet(w: PersistedPaperWallet): void {
    this.db.prepare(`
      INSERT INTO paper_wallets
        (wallet_id, display_name, strategy, capital, balance, realized_pnl,
         open_positions, risk_limits, trades, paused, updated_at, source, whale_addresses)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        whale_addresses = excluded.whale_addresses
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
    );
  }

  deleteWallet(walletId: string): void {
    this.db.prepare('DELETE FROM paper_wallets WHERE wallet_id = ?').run(walletId);
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
    }));
  }

  close(): void {
    this.db.close();
  }
}