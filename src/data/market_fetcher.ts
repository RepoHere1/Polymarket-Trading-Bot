import { MarketData } from '../types';
import { logger } from '../reporting/logs';

/** Raw shape returned by the Gamma API */
interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  outcomes: string;          // JSON string e.g. '["Yes","No"]'
  outcomePrices: string;     // JSON string e.g. '["0.55","0.45"]'
  clobTokenIds: string;      // JSON string of token-id strings
  bestBid: number;
  bestAsk: number;
  volume24hr: number;
  liquidityNum: number;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  /** ISO-8601 resolution / end date */
  endDate?: string;
  /** 1-day and 1-week price movements */
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number; exponent?: number };
  /** Nested events array – first entry carries event metadata */
  events?: Array<{
    id?: string;
    slug?: string;
    series?: Array<{ slug?: string }>;
  }>;
}

export class MarketFetcher {
  private readonly gammaApi: string;
  /** Max markets to return (0 = unlimited / fetch all pages) */
  private readonly limit: number;
  /** Page size for Gamma API pagination */
  private static readonly PAGE_SIZE = 100;

  constructor(gammaApi = 'https://gamma-api.polymarket.com', limit = 0) {
    this.gammaApi = gammaApi;
    this.limit = limit;
  }

  /**
   * Fetch active, open Polymarket markets sorted by volume.
   * Paginates through the Gamma API to collect all qualifying
   * markets (or up to `limit` if set).
   */
  async fetchSnapshot(): Promise<MarketData[]> {
    try {
      const raw = await this.fetchAllPages();
      const { markets, skippedNoQuote } = this.parseMarkets(raw);
      logger.info({ count: markets.length, skippedNoQuote, pages: Math.ceil(raw.length / MarketFetcher.PAGE_SIZE) }, 'Fetched live markets from Gamma API');
      return markets;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch markets from Gamma API');
      return [];
    }
  }

  /* ── Paginated fetcher ── */

  private async fetchAllPages(): Promise<GammaMarket[]> {
    const all: GammaMarket[] = [];
    let offset = 0;
    const pageSize = MarketFetcher.PAGE_SIZE;

    while (true) {
      const url = `${this.gammaApi}/markets?active=true&closed=false&limit=${pageSize}&offset=${offset}&order=volume24hr&ascending=false`;
      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 422) {
          /* Gamma caps deep offsets (422 past ~offset 2100) — that is the
             graceful end of pagination, not an error worth logging every
             refresh cycle. */
          logger.debug({ offset }, 'Gamma API offset cap reached — end of pages');
        } else {
          logger.error({ status: response.status, offset }, 'Gamma API page request failed');
        }
        break;
      }

      const page: GammaMarket[] = await response.json() as GammaMarket[];
      if (page.length === 0) break;

      all.push(...page);

      // Stop early if we've hit the caller-requested limit
      if (this.limit > 0 && all.length >= this.limit) {
        return all.slice(0, this.limit);
      }

      // Last page was under-full → no more data
      if (page.length < pageSize) break;

      offset += pageSize;
    }

    return all;
  }

  /* ── Parse raw Gamma response into MarketData ── */

  private parseMarkets(raw: GammaMarket[]): { markets: MarketData[]; skippedNoQuote: number } {
    const markets: MarketData[] = [];
    let skippedNoQuote = 0;

    for (const m of raw) {
      try {
        if (!m.acceptingOrders) continue;
        if (!m.clobTokenIds || m.clobTokenIds === '[]') continue;

        const outcomes: string[] = JSON.parse(m.outcomes || '[]');
        const outcomePrices: number[] = (JSON.parse(m.outcomePrices || '[]') as string[]).map(Number);
        const clobTokenIds: string[] = JSON.parse(m.clobTokenIds || '[]');

        if (outcomePrices.length === 0 || outcomePrices.every((p) => p === 0)) continue;

        const yesPrice = outcomePrices[0] ?? 0.5;
        const noPrice = outcomePrices[1] ?? 1 - yesPrice;

        /* Step C: a real two-sided quote is required. NO synthetic fallback.
           If Gamma gives no usable bid/ask (missing, non-positive, equal, or
           crossed), skip the market for this poll and count the skip. */
        const rawBid = m.bestBid;
        const rawAsk = m.bestAsk;
        const hasQuote =
          Number.isFinite(rawBid) &&
          Number.isFinite(rawAsk) &&
          rawBid > 0 &&
          rawAsk > 0 &&
          rawAsk > rawBid;
        if (!hasQuote) {
          skippedNoQuote++;
          continue;
        }
        const bid = rawBid;
        const ask = rawAsk;
        const mid = (bid + ask) / 2;

        markets.push({
          marketId: m.id,
          question: m.question,
          slug: m.slug,
          outcomes,
          outcomePrices: [yesPrice, noPrice],
          clobTokenIds,
          midPrice: Number(mid.toFixed(4)),
          bid: Number(bid.toFixed(4)),
          ask: Number(ask.toFixed(4)),
          spread: Number((ask - bid).toFixed(4)),
          volume24h: m.volume24hr ?? 0,
          liquidity: m.liquidityNum ?? 0,
          timestamp: Date.now(),
          endDate: m.endDate ?? undefined,
          eventId: m.events?.[0]?.id ?? undefined,
          eventSlug: m.events?.[0]?.slug ?? undefined,
          seriesSlug: m.events?.[0]?.series?.[0]?.slug ?? undefined,
          oneDayPriceChange: m.oneDayPriceChange ?? undefined,
          oneWeekPriceChange: m.oneWeekPriceChange ?? undefined,
          feeRate: m.feesEnabled ? (m.feeSchedule?.rate ?? 0) : 0,
          feeExponent: m.feeSchedule?.exponent ?? 0,
        });
      } catch {
        logger.warn({ marketId: m.id }, 'Skipping unparseable market');
      }
    }

    if (skippedNoQuote > 0) {
      logger.info({ skipped: skippedNoQuote }, 'Skipped markets without a real two-sided bid/ask quote');
    }

    return { markets, skippedNoQuote };
  }
}
