import { describe, it, expect, afterEach, vi } from 'vitest';
import { MarketFetcher } from '../src/data/market_fetcher';

function gammaMarket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1',
    question: 'Does the test pass?',
    slug: 'test-pass',
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.55","0.45"]',
    clobTokenIds: '["tok-yes","tok-no"]',
    bestBid: 0.54,
    bestAsk: 0.56,
    volume24hr: 1000,
    liquidityNum: 5000,
    active: true,
    closed: false,
    acceptingOrders: true,
    ...over,
  };
}

function stubPage(page: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => page })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MarketFetcher (real quotes only — no synthetic fallback)', () => {
  it('parses markets that have a real two-sided quote', async () => {
    stubPage([gammaMarket({ id: 'real' })]);
    const fetcher = new MarketFetcher('http://gamma.test');

    const markets = await fetcher.fetchSnapshot();

    expect(markets.length).toBe(1);
    expect(markets[0].bid).toBe(0.54);
    expect(markets[0].ask).toBe(0.56);
    expect(markets[0].midPrice).toBe(0.55);
    expect(markets[0].spread).toBe(0.02);
  });

  it('skips markets with zero, missing, equal, or crossed quotes — and never fabricates bid/ask', async () => {
    stubPage([
      gammaMarket({ id: 'zero', bestBid: 0, bestAsk: 0 }),
      gammaMarket({ id: 'missing-ask', bestAsk: undefined }),
      gammaMarket({ id: 'missing-bid', bestBid: undefined }),
      gammaMarket({ id: 'equal', bestBid: 0.55, bestAsk: 0.55 }),
      gammaMarket({ id: 'crossed', bestBid: 0.6, bestAsk: 0.5 }),
      gammaMarket({ id: 'real', bestBid: 0.54, bestAsk: 0.56 }),
    ]);
    const fetcher = new MarketFetcher('http://gamma.test');

    const markets = await fetcher.fetchSnapshot();

    expect(markets.map((m) => m.marketId)).toEqual(['real']);
  });

  it('does not synthesize a quote from outcomePrices (yesPrice ± 0.02 fallback removed)', async () => {
    // Old behaviour fabricated bid 0.53 / ask 0.57 from yesPrice 0.55 — that is gone.
    stubPage([gammaMarket({ id: 'no-quotes', bestBid: 0, bestAsk: 0 })]);
    const fetcher = new MarketFetcher('http://gamma.test');

    const markets = await fetcher.fetchSnapshot();

    expect(markets.length).toBe(0);
  });
});
