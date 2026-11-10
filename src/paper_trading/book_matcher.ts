import type { OrderBook } from '../data/clob_fetcher';

export interface MatchRequest {
  side: 'BUY' | 'SELL';
  /** Worst acceptable price: maximum for BUY, minimum for SELL */
  limitPrice: number;
  /** Shares requested */
  size: number;
}

export interface MatchResult {
  filledSize: number;
  /** Volume-weighted average execution price; 0 when nothing filled */
  avgPrice: number;
  /** USDC notional of executed shares (filledSize × avgPrice) */
  notional: number;
  unfilledSize: number;
}

/**
 * Walks the real CLOB L2 book the way a marketable limit order would.
 * Deterministic: no randomness, no artificial latency, no synthetic fallback.
 * BUY lifts asks at or below limitPrice; SELL hits bids at or above limitPrice.
 */
export function matchAgainstBook(book: OrderBook, req: MatchRequest): MatchResult {
  if (!Number.isFinite(req.size) || req.size <= 0) {
    throw new Error(`Invalid order size: ${req.size}`);
  }
  if (!Number.isFinite(req.limitPrice) || req.limitPrice <= 0 || req.limitPrice >= 1) {
    throw new Error(`Invalid limit price: ${req.limitPrice}`);
  }

  const levels = req.side === 'BUY' ? book.asks : book.bids;
  let remaining = req.size;
  let filledSize = 0;
  let notional = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const crosses =
      req.side === 'BUY' ? level.price <= req.limitPrice : level.price >= req.limitPrice;
    // Levels are sorted best-first, so the first non-crossing level ends the walk.
    if (!crosses) break;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    filledSize += take;
    notional += take * level.price;
    remaining -= take;
  }

  return {
    filledSize,
    avgPrice: filledSize > 0 ? notional / filledSize : 0,
    notional,
    unfilledSize: Math.max(0, req.size - filledSize),
  };
}

/**
 * Polymarket taker fee: fee = C × feeRate × (p × (1 − p))^exponent, in USDC,
 * rounded to 5 decimal places. Makers pay no fee, so callers pass taker fills only.
 */
export function takerFeeUsdc(
  shares: number,
  price: number,
  feeRate: number,
  exponent: number,
): number {
  if (shares <= 0 || feeRate <= 0 || price <= 0 || price >= 1) return 0;
  const raw = shares * feeRate * Math.pow(price * (1 - price), exponent);
  return Math.round(raw * 100000) / 100000;
}
