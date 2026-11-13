/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Polymarket Data API v2 client

   VERIFIED 2026-11-11 (live, from this bot's network):
   - The legacy v1 surface (`/trades?maker_address=…`, `/activity`, `/positions`
     on data-api.polymarket.com) is RETIRED — every path returns HTTP 410 Gone.
   - The CLOB `/trades` endpoint requires L2 auth and returns 401 for us.
   - The LIVE public surface is `/v2/*` on https://data-api.polymarket.com:
     no auth, `{ data, pagination }` envelope, CURSOR-ONLY pagination
     (`pagination.next_cursor`; there is no offset param — it is a 400).
   - `/v2/trades?user=<proxyWallet>` returns that wallet's trades, newest
     first, with fields: proxy_wallet, side, token_id, condition_id, size
     (shares), price, timestamp (unix seconds), outcome, outcome_index,
     transaction_hash.
   - 429 = rate limited with `Retry-After` (seconds); 503 = server-side
     timeout/dependency with `Retry-After`. Both are retryable.
   - Bare size values are SHARES; USD notional = size × price.

   This module normalises v2 rows into the LEGACY trade shape that the rest
   of the codebase already consumes (proxyWallet, conditionId, …), so call
   sites only change their URL/fetch plumbing, not their field mapping.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { logger } from '../reporting/logs';

/** Legacy trade shape used across whale_scanner / whale_candidates /
 *  copy_trade_strategy (matches the retired v1 data-api field names). */
export interface LegacyDataApiTrade {
  transactionHash: string;
  proxyWallet: string;
  asset: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  /** Unix seconds */
  timestamp: number;
  outcome: string;
  conditionId: string;
}

/** Error thrown for non-retryable / exhausted-retry HTTP failures.
 *  Real data or a real failure — never fabricated fallbacks. */
export class DataApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'DataApiError';
  }
}

/** Raw v2 trade row (subset of fields we consume). */
interface V2Trade {
  proxy_wallet?: string;
  side?: string;
  token_id?: string;
  condition_id?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number;
  outcome?: string;
  outcome_index?: number;
  transaction_hash?: string;
}

interface V2Envelope {
  data?: V2Trade[] | null;
  pagination?: { next_cursor?: string | null; has_more?: boolean };
}

export interface V2TradesPage {
  trades: LegacyDataApiTrade[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface V2TradesParams {
  user?: string;
  condition?: string;
  limit?: number;
  cursor?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

/** Map a v2 row to the legacy shape; null when the row is unusable. */
export function toLegacyTrade(t: V2Trade): LegacyDataApiTrade | null {
  const proxyWallet = (t.proxy_wallet ?? '').toLowerCase();
  if (!proxyWallet) return null;
  const price = Number(t.price ?? 0);
  const size = Number(t.size ?? 0);
  if (!(price > 0) || !(size > 0)) return null;
  const side: 'BUY' | 'SELL' = t.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  return {
    transactionHash: t.transaction_hash ?? '',
    proxyWallet,
    asset: t.token_id ?? '',
    side,
    size,
    price,
    timestamp: Number(t.timestamp ?? 0),
    outcome: t.outcome ?? '',
    conditionId: t.condition_id ?? '',
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ━━━━━━━━━━━━━━ Process-wide data-API budget ━━━━━━━━━━━━━━
   Every /v2/trades caller in this process (whale scanner, whale ingestion,
   whale candidates, copy-trade lanes) funnels through fetchV2TradesPage, so
   this is the ONE honest choke point for the shared public host
   (data-api.polymarket.com). Before this existed, two copy lanes swept
   224 whales each every 30 s (~15 req/s sustained, more with retries),
   429-storming the host and blinding every consumer — including the lanes
   themselves (fetch errors were swallowed as empty pages, so NOTHING was
   ever copied) and the scanner ("endpoint marked unhealthy" latch).
   Budget: DATA_API_RATE_LIMIT_RPS sustained (default 1.1 ≈ the host budget
   the pool has always assumed), burst 8, plus an exponential process-wide
   penalty window after any 429/503 (Retry-After wins when larger).
   Disabled under vitest — tests stub fetch and must not be throttled. */

const DATA_API_RPS = (() => {
  const n = Number(process.env.DATA_API_RATE_LIMIT_RPS ?? '');
  return Number.isFinite(n) && n > 0 ? n : 1.1;
})();
const DATA_API_BURST = 8;
const PENALTY_FLOOR_MS = 1_000;
const PENALTY_CAP_MS = 60_000;
const LIMITER_DISABLED = Boolean(process.env.VITEST);

const limiterState = {
  tokens: DATA_API_BURST,
  lastRefillAt: Date.now(),
  penaltyMs: PENALTY_FLOOR_MS,
  penaltyUntil: 0,
};

/** Concurrent identical requests share one HTTP call (two copy lanes
 *  polling the same whale in the same instant = one request, one budget
 *  token). Sequential callers are never affected. */
const inFlightPages = new Map<string, Promise<V2TradesPage>>();

export interface DataApiLimiterStats {
  rps: number;
  burst: number;
  tokens: number;
  penaltyMs: number;
  penaltyUntilInMs: number;
  disabled: boolean;
}

function refillTokens(now = Date.now()): void {
  const gained = ((now - limiterState.lastRefillAt) / 1000) * DATA_API_RPS;
  limiterState.tokens = Math.min(DATA_API_BURST, limiterState.tokens + gained);
  limiterState.lastRefillAt = now;
}

async function acquireDataApiSlot(): Promise<void> {
  if (LIMITER_DISABLED) return;
  for (;;) {
    refillTokens();
    const penaltyWait = limiterState.penaltyUntil - Date.now();
    if (limiterState.tokens >= 1 && penaltyWait <= 0) {
      limiterState.tokens -= 1;
      return;
    }
    const waitMs = penaltyWait > 0
      ? penaltyWait
      : ((1 - limiterState.tokens) / DATA_API_RPS) * 1000;
    await sleep(Math.max(25, waitMs));
  }
}

/** Pure penalty growth — exported for unit tests. Doubles the previous
 *  penalty (floor 1 s, cap 60 s) and never shrinks below Retry-After. */
export function nextDataApi429PenaltyMs(prevMs: number, retryAfterSec: number | null): number {
  const fromRetry = retryAfterSec !== null && retryAfterSec >= 0 ? retryAfterSec * 1000 : 0;
  const doubled = Math.min(PENALTY_CAP_MS, Math.max(PENALTY_FLOOR_MS, prevMs * 2));
  return Math.min(PENALTY_CAP_MS, Math.max(doubled, fromRetry));
}

function noteDataApiBusy(retryAfterSec: number | null): void {
  limiterState.penaltyMs = nextDataApi429PenaltyMs(limiterState.penaltyMs, retryAfterSec);
  limiterState.penaltyUntil = Math.max(limiterState.penaltyUntil, Date.now() + limiterState.penaltyMs);
}

function noteDataApiHealthy(): void {
  limiterState.penaltyMs = PENALTY_FLOOR_MS;
  limiterState.penaltyUntil = 0;
}

/** Observability for dashboards / probes. */
export function getDataApiLimiterStats(): DataApiLimiterStats {
  refillTokens();
  return {
    rps: DATA_API_RPS,
    burst: DATA_API_BURST,
    tokens: limiterState.tokens,
    penaltyMs: limiterState.penaltyMs,
    penaltyUntilInMs: Math.max(0, limiterState.penaltyUntil - Date.now()),
    disabled: LIMITER_DISABLED,
  };
}

/**
 * Fetch one page of /v2/trades. Throttled by the process-wide budget above;
 * concurrent identical requests coalesce into one HTTP call. Retries 429/503
 * honouring Retry-After (up to MAX_RETRIES), then throws DataApiError —
 * callers decide how to surface the failure (pool health, empty result for
 * non-critical paths). The returned page object may be SHARED between
 * concurrent callers: treat it as read-only.
 */
export async function fetchV2TradesPage(
  baseUrl: string,
  params: V2TradesParams,
  opts: { timeoutMs?: number } = {},
): Promise<V2TradesPage> {
  const root = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${root}/v2/trades`);
  if (params.user) url.searchParams.set('user', params.user);
  if (params.condition) url.searchParams.set('condition', params.condition);
  if (params.limit && params.limit > 0) url.searchParams.set('limit', String(params.limit));
  if (params.cursor) url.searchParams.set('cursor', params.cursor);

  const key = url.toString();
  const existing = inFlightPages.get(key);
  if (existing) return existing;

  const pending = fetchV2TradesPageInner(url, opts).finally(() => {
    inFlightPages.delete(key);
  });
  inFlightPages.set(key, pending);
  return pending;
}

async function fetchV2TradesPageInner(
  url: URL,
  opts: { timeoutMs?: number } = {},
): Promise<V2TradesPage> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    /* Every HTTP attempt — including retries — consumes budget. */
    await acquireDataApiSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      /* String form: interceptors and test stubs match on substrings. */
      res = await fetch(url.toString(), { signal: controller.signal });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (attempt === MAX_RETRIES) {
        throw new DataApiError(`v2 trades fetch failed: ${(err as Error).message}`, 0);
      }
      await sleep(Math.pow(2, attempt) * 500);
      continue;
    }
    clearTimeout(timer);

    if (res.ok) {
      const body = (await res.json()) as V2Envelope;
      const rows = Array.isArray(body.data) ? body.data : [];
      const trades = rows
        .map(toLegacyTrade)
        .filter((t): t is LegacyDataApiTrade => t !== null);
      const nextCursor = body.pagination?.next_cursor ?? null;
      const hasMore = body.pagination?.has_more === true && nextCursor !== null;
      noteDataApiHealthy();
      return { trades, nextCursor, hasMore };
    }

    if (res.status === 429 || res.status === 503) {
      /* Retry-After is SECONDS. "0" is a legal value (retry immediately) —
         only a missing/unparseable header falls back to the 5 s default. */
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '', 10);
      const waitMs = (Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 5) * 1000;
      noteDataApiBusy(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null);
      if (attempt < MAX_RETRIES) {
        logger.warn({ status: res.status, waitMs, path: url.pathname }, 'Data API v2 busy - backing off');
        await sleep(waitMs);
        continue;
      }
    }

    throw new DataApiError(`v2 trades request failed with HTTP ${res.status} on ${url.pathname}`, res.status);
  }

  /* Unreachable — the loop always returns or throws */
  throw new DataApiError('v2 trades fetch exhausted retries', 0);
}

/**
 * Walk the cursor chain until exhausted (or maxPages). Pages are sequential
 * by design — v2 has no offset parameter.
 */
export async function fetchAllV2Trades(
  baseUrl: string,
  params: V2TradesParams,
  opts: { maxPages?: number; timeoutMs?: number } = {},
): Promise<LegacyDataApiTrade[]> {
  const maxPages = opts.maxPages ?? 5;
  const all: LegacyDataApiTrade[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const result = await fetchV2TradesPage(baseUrl, { ...params, cursor }, { timeoutMs: opts.timeoutMs });
    all.push(...result.trades);
    if (!result.hasMore || result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  return all;
}
