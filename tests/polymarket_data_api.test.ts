import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchV2TradesPage,
  fetchAllV2Trades,
  toLegacyTrade,
  DataApiError,
  nextDataApi429PenaltyMs,
} from '../src/data/polymarket_data_api';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Data API v2 client — verified against the LIVE public surface
   (https://data-api.polymarket.com/v2/trades, { data, pagination },
   cursor-only, no auth) on 2026-11-11.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function v2Row(overrides: Record<string, unknown> = {}) {
  return {
    proxy_wallet: '0x1ee9a5fc09665909c0cce297c581703bfbb9197f',
    side: 'BUY',
    token_id: '38121592119972198489520429217721710869195013287648052909122512139542317776371',
    condition_id: '0x6215a6b38b51de4e1d0254da3cbb1d25bd75497276fedbbcd6bbcc7e126bff19',
    size: 2000,
    price: 0.64,
    timestamp: 1794448297,
    outcome: 'No',
    outcome_index: 1,
    transaction_hash: '0x94da7b29c502fe405288c81db555b71f94ac96d00184a946a2fd66171a50c3ef',
    ...overrides,
  };
}

function okResponse(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  };
}

describe('toLegacyTrade', () => {
  it('maps v2 snake_case rows onto the legacy shape', () => {
    const t = toLegacyTrade(v2Row({ side: 'SELL' }));
    expect(t).not.toBeNull();
    expect(t!.proxyWallet).toBe('0x1ee9a5fc09665909c0cce297c581703bfbb9197f');
    expect(t!.side).toBe('SELL');
    expect(t!.asset).toBe('38121592119972198489520429217721710869195013287648052909122512139542317776371');
    expect(t!.conditionId).toBe('0x6215a6b38b51de4e1d0254da3cbb1d25bd75497276fedbbcd6bbcc7e126bff19');
    expect(t!.size).toBe(2000);
    expect(t!.price).toBe(0.64);
    expect(t!.timestamp).toBe(1794448297);
    expect(t!.outcome).toBe('No');
    expect(t!.transactionHash).toBe('0x94da7b29c502fe405288c81db555b71f94ac96d00184a946a2fd66171a50c3ef');
  });

  it('rejects rows without a wallet or with non-positive price/size', () => {
    expect(toLegacyTrade(v2Row({ proxy_wallet: '' }))).toBeNull();
    expect(toLegacyTrade(v2Row({ price: 0 }))).toBeNull();
    expect(toLegacyTrade(v2Row({ size: 0 }))).toBeNull();
  });
});

describe('fetchV2TradesPage', () => {
  it('unwraps the { data, pagination } envelope and exposes cursor state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      data: [v2Row()],
      pagination: { next_cursor: 'eyJkYXRhIjoxfQ', has_more: true },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchV2TradesPage('https://data-api.test', { user: '0xabc', limit: 50 });
    expect(page.trades).toHaveLength(1);
    expect(page.nextCursor).toBe('eyJkYXRhIjoxfQ');
    expect(page.hasMore).toBe(true);

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(calledUrl.pathname).toBe('/v2/trades');
    expect(calledUrl.searchParams.get('user')).toBe('0xabc');
    expect(calledUrl.searchParams.get('limit')).toBe('50');
  });

  it('treats a missing data array as an empty page (not an error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({})));
    const page = await fetchV2TradesPage('https://data-api.test', { user: '0xabc' });
    expect(page.trades).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => '0' },
      })
      .mockResolvedValueOnce(okResponse({ data: [v2Row()], pagination: { next_cursor: null, has_more: false } }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchV2TradesPage('https://data-api.test', { user: '0xabc' });
    expect(page.trades).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws DataApiError on hard 4xx (e.g. the retired v1-style 410)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
      headers: { get: () => null },
    }));
    await expect(fetchV2TradesPage('https://data-api.test', { user: '0xabc' }))
      .rejects.toMatchObject({ name: 'DataApiError', status: 410 });
  });
});

describe('fetchAllV2Trades', () => {
  it('walks the cursor chain until has_more is false', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({
        data: [v2Row({ timestamp: 200 })],
        pagination: { next_cursor: 'cur1', has_more: true },
      }))
      .mockResolvedValueOnce(okResponse({
        data: [v2Row({ timestamp: 100 })],
        pagination: { next_cursor: null, has_more: false },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const trades = await fetchAllV2Trades('https://data-api.test', { user: '0xabc' }, { maxPages: 5 });
    expect(trades).toHaveLength(2);

    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(secondUrl.searchParams.get('cursor')).toBe('cur1');
  });

  it('stops at maxPages even when has_more is still true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      data: [v2Row()],
      pagination: { next_cursor: 'keep-going', has_more: true },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const trades = await fetchAllV2Trades('https://data-api.test', { user: '0xabc' }, { maxPages: 2 });
    expect(trades).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('DataApiError', () => {
  it('carries the HTTP status', () => {
    const err = new DataApiError('boom', 410);
    expect(err.status).toBe(410);
    expect(err.message).toContain('boom');
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Process-wide data-API budget (token bucket + 429 penalty +
   in-flight coalescing). The limiter's await path is disabled under
   vitest (fetch is stubbed) — the pure penalty math and coalescing
   behaviour are still fully exercised here.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('data-API budget', () => {
  it('429 penalty doubles per hit, honours Retry-After, caps at 60 s', () => {
    expect(nextDataApi429PenaltyMs(1_000, null)).toBe(2_000);
    expect(nextDataApi429PenaltyMs(2_000, null)).toBe(4_000);
    expect(nextDataApi429PenaltyMs(40_000, null)).toBe(60_000); // capped
    expect(nextDataApi429PenaltyMs(1_000, 30)).toBe(30_000); // Retry-After wins when larger
    expect(nextDataApi429PenaltyMs(1_000, 0)).toBe(2_000); // "0" never shrinks growth
  });

  it('coalesces concurrent identical requests into ONE HTTP call', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20)); // keep both callers in flight
      return okResponse({ data: [v2Row()], pagination: { next_cursor: null, has_more: false } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([
      fetchV2TradesPage('https://data-api.test', { user: '0xabc' }),
      fetchV2TradesPage('https://data-api.test', { user: '0xabc' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // the exact same shared page object
    expect(a.trades).toHaveLength(1);
  });

  it('sequential identical requests are NOT coalesced (fresh fetch each)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ data: [], pagination: { next_cursor: null, has_more: false } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchV2TradesPage('https://data-api.test', { user: '0xabc' });
    await fetchV2TradesPage('https://data-api.test', { user: '0xabc' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed shared request rejects every caller (no fake fallback)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.allSettled([
      fetchV2TradesPage('https://data-api.test', { user: '0xdead' }),
      fetchV2TradesPage('https://data-api.test', { user: '0xdead' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one HTTP attempt chain, shared
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
  });
});
