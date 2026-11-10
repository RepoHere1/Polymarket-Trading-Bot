import { describe, it, expect } from 'vitest';
import { PaperWallet, PaperMarketData } from '../src/wallets/paper_wallet';
import { OrderBook, ClobFetcher } from '../src/data/clob_fetcher';
import { OrderbookStream } from '../src/data/orderbook_stream';
import { MarketData, WalletConfig } from '../src/types';

const config: WalletConfig = { id: 'paper_test', mode: 'PAPER', strategy: 'test', capital: 1000 };

const market = {
  marketId: 'mkt-1',
  clobTokenIds: ['yes-token', 'no-token'],
  feeRate: 0,
  feeExponent: 0,
} as unknown as MarketData;

const book: OrderBook = {
  asks: [
    { price: 0.5, size: 10 },
    { price: 0.6, size: 10 },
  ],
  bids: [
    { price: 0.5, size: 10 },
    { price: 0.4, size: 10 },
  ],
};

function dataFor(b: OrderBook | null, m: MarketData = market): PaperMarketData {
  return {
    stream: {
      getMarket: (id: string) => (id === m.marketId ? m : undefined),
    } as unknown as OrderbookStream,
    clobFetcher: { fetchOrderBook: async () => b } as unknown as ClobFetcher,
  };
}

function wallet(data: PaperMarketData | undefined): PaperWallet {
  return new PaperWallet(config, 'test', () => data);
}

describe('PaperWallet (real book fills)', () => {
  it('fills a BUY at book VWAP and charges the taker fee in USDC', async () => {
    const feeMarket = { ...market, feeRate: 0.07, feeExponent: 1 } as unknown as MarketData;
    const w = wallet(dataFor(book, feeMarket));
    const fill = await w.placeOrder({ marketId: 'mkt-1', outcome: 'YES', side: 'BUY', price: 0.6, size: 10 });
    expect(fill?.price).toBeCloseTo(0.5, 10);
    expect(fill?.fee).toBeCloseTo(0.175, 10);
    const s = w.getState();
    expect(s.availableBalance).toBeCloseTo(1000 - 5 - 0.175, 6);
    expect(s.realizedPnl).toBeCloseTo(-0.175, 6);
    expect(s.openPositions[0]?.size).toBe(10);
  });

  it('refuses to sell shares it does not hold (no phantom cash)', async () => {
    const w = wallet(dataFor(book));
    const fill = await w.placeOrder({ marketId: 'mkt-1', outcome: 'YES', side: 'SELL', price: 0.4, size: 50 });
    expect(fill).toBeNull();
    expect(w.getState().availableBalance).toBe(1000);
    expect(w.getTradeHistory()).toHaveLength(0);
  });

  it('clamps a SELL to held shares and books realized PnL', async () => {
    const richBook: OrderBook = {
      asks: [{ price: 0.5, size: 100 }],
      bids: [{ price: 0.55, size: 100 }],
    };
    const w = wallet(dataFor(richBook));
    await w.placeOrder({ marketId: 'mkt-1', outcome: 'YES', side: 'BUY', price: 0.5, size: 10 });
    const sell = await w.placeOrder({ marketId: 'mkt-1', outcome: 'YES', side: 'SELL', price: 0.4, size: 50 });
    expect(sell?.size).toBe(10);
    const s = w.getState();
    expect(s.openPositions).toHaveLength(0);
    expect(s.realizedPnl).toBeCloseTo(0.5, 10);
    expect(s.availableBalance).toBeCloseTo(1000.5, 10);
  });

  it('does not fill when the book does not cross the limit', async () => {
    const w = wallet(dataFor(book));
    const fill = await w.placeOrder({ marketId: 'mkt-1', outcome: 'YES', side: 'BUY', price: 0.4, size: 5 });
    expect(fill).toBeNull();
    expect(w.getState().availableBalance).toBe(1000);
  });

  it('throws instead of simulating when market data is not connected', async () => {
    const w = wallet(undefined);
    await expect(
      w.placeOrder({ marketId: 'mkt-1', outcome: 'YES', side: 'BUY', price: 0.6, size: 10 }),
    ).rejects.toThrow(/refusing to simulate/);
  });

  it('throws when the live CLOB book is unavailable', async () => {
    const w = wallet(dataFor(null));
    await expect(
      w.placeOrder({ marketId: 'mkt-1', outcome: 'YES', side: 'BUY', price: 0.6, size: 10 }),
    ).rejects.toThrow(/refusing to simulate/);
  });
});
