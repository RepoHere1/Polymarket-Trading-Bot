import { describe, it, expect, vi } from 'vitest';
import { PolymarketWallet, PolymarketClientLike } from '../src/wallets/polymarket_wallet';
import { WalletConfig } from '../src/types';

const config: WalletConfig = { id: 'live_test', mode: 'LIVE', strategy: 'test', capital: 1000 };

const liveEnv = { ENABLE_LIVE_TRADING: 'true', POLYMARKET_DRY_RUN: 'false' };

function execution(shares: string, px: string, fee?: string) {
  return {
    id: `ex-${shares}-${px}`,
    type: 'EXECUTION_TYPE_FILL',
    lastShares: shares,
    lastPx: { value: px, currency: 'USD' },
    ...(fee ? { commissionNotionalCollected: { value: fee, currency: 'USD' } } : {}),
  };
}

function makeFns(overrides?: {
  balances?: ReturnType<typeof vi.fn>;
  retrieveBySlug?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  preview?: ReturnType<typeof vi.fn>;
}) {
  const balances =
    overrides?.balances ??
    vi.fn().mockResolvedValue({ balances: [{ currency: 'USD', currentBalance: 500, buyingPower: 450 }] });
  const retrieveBySlug = overrides?.retrieveBySlug ?? vi.fn().mockResolvedValue({ market: {} });
  const create =
    overrides?.create ?? vi.fn().mockResolvedValue({ id: 'ord-1', executions: [execution('10', '0.5', '0.175')] });
  const preview = overrides?.preview ?? vi.fn().mockResolvedValue({ order: { id: 'prev-1', state: 'ORDER_STATE_OPEN' } });
  const client: PolymarketClientLike = {
    orders: { create, preview },
    account: { balances },
    portfolio: { positions: vi.fn().mockResolvedValue({ positions: [] }) },
    markets: { retrieveBySlug },
  };
  return { client, create, preview, balances, retrieveBySlug };
}

function wallet(opts?: {
  env?: NodeJS.ProcessEnv;
  fns?: ReturnType<typeof makeFns>;
  resolveSlug?: (id: string) => string | undefined;
}): PolymarketWallet {
  const fns = opts?.fns ?? makeFns();
  return new PolymarketWallet(config, 'test', {
    clientFactory: () => fns.client,
    resolveSlug: opts?.resolveSlug ?? ((id) => (id === 'mkt-1' ? 'mkt-1-slug' : undefined)),
    env: opts?.env ?? liveEnv,
  });
}

const buyYes = { marketId: 'mkt-1', outcome: 'YES' as const, side: 'BUY' as const, price: 0.5, size: 10 };

describe('PolymarketWallet (LIVE, polyUSA)', () => {
  it('refuses to send unless ENABLE_LIVE_TRADING is exactly "true"', async () => {
    const w = wallet({ env: { ENABLE_LIVE_TRADING: 'True', POLYMARKET_DRY_RUN: 'false' } });
    await expect(w.placeOrder(buyYes)).rejects.toThrow(/ENABLE_LIVE_TRADING/);
  });

  it('refuses to send when polyUSA credentials are missing', async () => {
    const w = new PolymarketWallet(config, 'test', {
      clientFactory: () => undefined,
      resolveSlug: (id) => (id === 'mkt-1' ? 'mkt-1-slug' : undefined),
      env: liveEnv,
    });
    await expect(w.placeOrder(buyYes)).rejects.toThrow(/credentials missing/);
  });

  it('defaults to DRY RUN: previews the order and never calls create', async () => {
    const fns = makeFns();
    const w = wallet({ env: { ENABLE_LIVE_TRADING: 'true' }, fns });
    const fill = await w.placeOrder(buyYes);
    expect(fill).toBeNull();
    expect(fns.preview).toHaveBeenCalledTimes(1);
    expect(fns.create).not.toHaveBeenCalled();
    expect(fns.preview).toHaveBeenCalledWith({
      request: expect.objectContaining({
        marketSlug: 'mkt-1-slug',
        intent: 'ORDER_INTENT_BUY_LONG',
        type: 'ORDER_TYPE_LIMIT',
        price: { value: '0.500', currency: 'USD' },
        quantity: 10,
        tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
      }),
    });
  });

  it('places a real order only when POLYMARKET_DRY_RUN === "false" and books the fill', async () => {
    const fns = makeFns();
    const w = wallet({ fns });
    const fill = await w.placeOrder(buyYes);
    expect(fns.preview).not.toHaveBeenCalled();
    expect(fns.create).toHaveBeenCalledWith(
      expect.objectContaining({ marketSlug: 'mkt-1-slug', intent: 'ORDER_INTENT_BUY_LONG', quantity: 10 }),
    );
    expect(fill).toMatchObject({ orderId: 'ord-1', price: 0.5, size: 10, fee: 0.175, feeAsset: 'USDC' });
    const s = w.getState();
    // Balance starts at exchange buying power 450, then pays 10 × $0.5 + $0.175 fee.
    expect(s.availableBalance).toBeCloseTo(450 - 5 - 0.175, 6);
    expect(s.openPositions[0]).toMatchObject({ size: 10, avgPrice: 0.5 });
    expect(s.realizedPnl).toBeCloseTo(-0.175, 6);
    expect(w.getTradeHistory()).toHaveLength(1);
  });

  it('aggregates multiple executions into one VWAP fill', async () => {
    const fns = makeFns({
      create: vi.fn().mockResolvedValue({
        id: 'ord-2',
        executions: [execution('10', '0.4', '0.1'), execution('10', '0.6', '0.2')],
      }),
    });
    const w = wallet({ fns });
    const fill = await w.placeOrder(buyYes);
    expect(fill?.price).toBeCloseTo(0.5, 10);
    expect(fill?.size).toBe(20);
    expect(fill?.fee).toBeCloseTo(0.3, 10);
  });
  it('reports no fill when the exchange returns no executions', async () => {
    const fns = makeFns({ create: vi.fn().mockResolvedValue({ id: 'ord-3' }) });
    const w = wallet({ fns });
    const fill = await w.placeOrder(buyYes);
    expect(fill).toBeNull();
    expect(w.getState().openPositions).toHaveLength(0);
    expect(w.getTradeHistory()).toHaveLength(0);
  });

  it('clamps a SELL to held shares and books realized PnL', async () => {
    const fns = makeFns({
      create: vi
        .fn()
        .mockResolvedValueOnce({ id: 'ord-4', executions: [execution('10', '0.5', '0.175')] })
        .mockResolvedValueOnce({ id: 'ord-5', executions: [execution('10', '0.55', '0.1')] }),
    });
    const w = wallet({ fns });
    await w.placeOrder(buyYes);
    const sell = await w.placeOrder({ marketId: 'mkt-1', outcome: 'YES', side: 'SELL', price: 0.55, size: 50 });
    expect(fns.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ quantity: 10, intent: 'ORDER_INTENT_SELL_LONG' }),
    );
    expect(sell).toMatchObject({ price: 0.55, size: 10 });
    const s = w.getState();
    expect(s.openPositions).toHaveLength(0);
    // Buy: −0.175 fee. Sell: (0.55 − 0.5) × 10 − 0.1 = +0.4.
    expect(s.realizedPnl).toBeCloseTo(0.225, 6);
    // The SELL's pre-trade refreshState(true) resets the balance to exchange
    // buying power (450); the sell then credits 10 × $0.55 − $0.1.
    expect(s.availableBalance).toBeCloseTo(450 + 5.5 - 0.1, 6);
  });

  it('rejects a SELL with no shares held', async () => {
    const fns = makeFns();
    const w = wallet({ fns });
    const fill = await w.placeOrder({ marketId: 'mkt-1', outcome: 'NO', side: 'SELL', price: 0.5, size: 10 });
    expect(fill).toBeNull();
    expect(fns.create).not.toHaveBeenCalled();
  });

  it('drops markets that are not in the live slug cache', async () => {
    const fns = makeFns();
    const w = wallet({ fns });
    const fill = await w.placeOrder({ marketId: 'mkt-unknown', outcome: 'YES', side: 'BUY', price: 0.5, size: 10 });
    expect(fill).toBeNull();
    expect(fns.create).not.toHaveBeenCalled();
  });

  it('drops markets missing from the polyUSA catalog and caches the miss', async () => {
    const retrieveBySlug = vi.fn().mockRejectedValue(new Error('NotFound'));
    const fns = makeFns({ retrieveBySlug });
    const w = wallet({ fns });
    const req = { marketId: 'mkt-1', outcome: 'YES' as const, side: 'BUY' as const, price: 0.5, size: 10 };
    expect(await w.placeOrder(req)).toBeNull();
    expect(await w.placeOrder(req)).toBeNull();
    expect(retrieveBySlug).toHaveBeenCalledTimes(1);
    expect(fns.create).not.toHaveBeenCalled();
  });

  it('drops orders priced outside (0,1)', async () => {
    const fns = makeFns();
    const w = wallet({ fns });
    expect(await w.placeOrder({ ...buyYes, price: 1.0 })).toBeNull();
    expect(await w.placeOrder({ ...buyYes, price: 0 })).toBeNull();
    expect(fns.create).not.toHaveBeenCalled();
  });

  it('refuses to trade when a forced balance refresh fails', async () => {
    const fns = makeFns({ balances: vi.fn().mockRejectedValue(new Error('503')) });
    const w = wallet({ fns });
    await expect(w.placeOrder(buyYes)).rejects.toThrow(/refusing to trade/);
  });

  it('reads the balance from the exchange (buying power, USD only)', async () => {
    const fns = makeFns({
      balances: vi.fn().mockResolvedValue({
        balances: [
          { currency: 'USD', currentBalance: 500, buyingPower: 450 },
          { currency: 'ETH', currentBalance: 2, buyingPower: 2 },
        ],
      }),
    });
    const w = wallet({ fns });
    await w.refreshState(true);
    expect(w.getState().availableBalance).toBeCloseTo(450, 10);
  });
});
