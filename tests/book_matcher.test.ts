import { describe, it, expect } from 'vitest';
import { matchAgainstBook, takerFeeUsdc } from '../src/paper_trading/book_matcher';
import type { OrderBook } from '../src/data/clob_fetcher';

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

describe('matchAgainstBook', () => {
  it('stops at the limit price and reports the unfilled remainder', () => {
    const r = matchAgainstBook(book, { side: 'BUY', limitPrice: 0.55, size: 15 });
    expect(r.filledSize).toBe(10);
    expect(r.avgPrice).toBe(0.5);
    expect(r.unfilledSize).toBe(5);
  });

  it('walks multiple levels to a VWAP when the limit allows', () => {
    const r = matchAgainstBook(book, { side: 'BUY', limitPrice: 0.6, size: 15 });
    expect(r.filledSize).toBe(15);
    expect(r.notional).toBeCloseTo(8, 10);
    expect(r.avgPrice).toBeCloseTo(8 / 15, 10);
    expect(r.unfilledSize).toBe(0);
  });

  it('hits bids for SELL and respects the minimum price', () => {
    const r = matchAgainstBook(book, { side: 'SELL', limitPrice: 0.45, size: 15 });
    expect(r.filledSize).toBe(10);
    expect(r.avgPrice).toBe(0.5);
  });

  it('returns no fill when the book does not cross the limit', () => {
    const r = matchAgainstBook(book, { side: 'BUY', limitPrice: 0.4, size: 5 });
    expect(r.filledSize).toBe(0);
    expect(r.avgPrice).toBe(0);
    expect(r.unfilledSize).toBe(5);
  });

  it('rejects invalid size and price', () => {
    expect(() => matchAgainstBook(book, { side: 'BUY', limitPrice: 0.5, size: 0 })).toThrow();
    expect(() => matchAgainstBook(book, { side: 'BUY', limitPrice: 1, size: 5 })).toThrow();
  });
});

describe('takerFeeUsdc', () => {
  it('matches the documented Crypto table (100 shares @ 0.50 = $1.75)', () => {
    expect(takerFeeUsdc(100, 0.5, 0.07, 1)).toBe(1.75);
  });

  it('is symmetric around 50% and zero for zero-rate markets', () => {
    expect(takerFeeUsdc(100, 0.3, 0.04, 1)).toBeCloseTo(takerFeeUsdc(100, 0.7, 0.04, 1), 10);
    expect(takerFeeUsdc(100, 0.5, 0, 1)).toBe(0);
  });
});
