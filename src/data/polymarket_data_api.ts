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

/**
 * Fetch one page of /v2/trades. Retries 429/503 honouring Retry-After
 * (up to MAX_RETRIES), then throws DataApiError — callers decide how to
 * surface the failure (pool health, empty result for non-critical paths).
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

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
      return { trades, nextCursor, hasMore };
    }

    if (res.status === 429 || res.status === 503) {
      /* Retry-After is SECONDS. "0" is a legal value (retry immediately) —
         only a missing/unparseable header falls back to the 5 s default. */
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '', 10);
      const waitMs = (Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 5) * 1000;
      if (attempt < MAX_RETRIES) {
        logger.warn({ status: res.status, waitMs, path: url.pathname }, 'Data API v2 busy — backing off');
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
