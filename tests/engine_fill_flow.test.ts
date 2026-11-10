import { describe, it, expect } from 'vitest';
import { Engine } from '../src/core/engine';
import { OrderRouter } from '../src/execution/order_router';
import { TradeExecutor } from '../src/execution/trade_executor';
import { RiskEngine } from '../src/risk/risk_engine';
import { KillSwitch } from '../src/risk/kill_switch';
import { WalletManager } from '../src/wallets/wallet_manager';
import { StrategyInterface } from '../src/strategies/strategy_interface';
import { ClobFetcher, OrderBook } from '../src/data/clob_fetcher';
import { AppConfig, MarketData, OrderFill, OrderRequest, WalletState } from '../src/types';

/* ── Stubs ── */

interface PlaceOrderRequest {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

class RecordingWallet {
  public calls = 0;
  public lastRequest: PlaceOrderRequest | null = null;
  constructor(
    private readonly state: WalletState,
    public nextFill: OrderFill | null = null,
  ) {}
  getState(): WalletState {
    return this.state;
  }
  getTradeHistory() {
    return [];
  }
  updateBalance(): void {
    return;
  }
  async placeOrder(request: PlaceOrderRequest): Promise<OrderFill | null> {
    this.calls++;
    this.lastRequest = request;
    return this.nextFill;
  }
}

interface Harness {
  wallet: RecordingWallet;
  /** OrderRequests the strategy was notified about (notifyFill calls) */
  fills: OrderRequest[];
  processSignals(): Promise<void>;
  seedMarket(market: MarketData): void;
}

function buildHarness(
  book: OrderBook,
  nextFill: OrderFill | null,
  orderOver: Partial<OrderRequest> = {},
): Harness {
  const order: OrderRequest = {
    walletId: 'w1',
    marketId: 'mkt-1',
    outcome: 'YES',
    side: 'BUY',
    price: 0.5,
    size: 10,
    strategy: 'stub',
    ...orderOver,
  };

  const fills: OrderRequest[] = [];
  const strategy = {
    name: 'stub',
    initialize(): void {},
    onMarketUpdate(): void {},
    onTimer(): void {},
    generateSignals() {
      return [{ marketId: order.marketId, outcome: order.outcome, side: order.side, confidence: 0.8, edge: 0.1 }];
    },
    sizePositions() {
      return [order];
    },
    submitOrders(): void {},
    notifyFill(o: OrderRequest): void {
      fills.push(o);
    },
    managePositions(): void {},
    drainExitOrders(): OrderRequest[] {
      return [];
    },
    shutdown(): void {},
  } as unknown as StrategyInterface;

  const state: WalletState = {
    walletId: 'w1',
    mode: 'PAPER',
    assignedStrategy: 'stub',
    capitalAllocated: 1000,
    availableBalance: 1000,
    openPositions: [],
    realizedPnl: 0,
    riskLimits: {
      maxPositionSize: 1000,
      maxExposurePerMarket: 10000,
      maxDailyLoss: 1000,
      maxOpenTrades: 10,
      maxDrawdown: 1,
    },
  };

  const wallet = new RecordingWallet(state, nextFill);

  const manager = new WalletManager();
  manager.registerExternalWallet('w1', wallet);

  const clobStub = { fetchOrderBook: async () => book } as unknown as ClobFetcher;

  const config: AppConfig = {
    environment: { enableLiveTrading: false },
    wallets: [],
    strategyConfig: {},
    polymarket: { gammaApi: 'http://gamma.test', clobApi: 'http://clob.test' },
  };

  const engine = new Engine(
    config,
    manager,
    new OrderRouter(manager, new RiskEngine(new KillSwitch()), new TradeExecutor()),
    clobStub,
  );

  const runner = { strategy, walletId: 'w1', config: {} };
  const internals = engine as unknown as {
    runners: unknown[];
    stream: { cache: Map<string, MarketData> };
    processSignals(r: unknown): Promise<void>;
  };
  internals.runners.push(runner);

  return {
    wallet,
    fills,
    processSignals: () => internals.processSignals(runner),
    seedMarket: (market: MarketData) => internals.stream.cache.set(market.marketId, market),
  };
}

function marketData(over: Partial<MarketData> = {}): MarketData {
  return {
    marketId: 'mkt-1',
    question: 'Test market?',
    slug: 'test-market',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.5, 0.5],
    clobTokenIds: ['tok-yes', 'tok-no'],
    midPrice: 0.5,
    bid: 0.49,
    ask: 0.51,
    spread: 0.02,
    volume24h: 1000,
    liquidity: 5000,
    timestamp: Date.now(),
    ...over,
  };
}

const realFill: OrderFill = {
  orderId: 'f1',
  marketId: 'mkt-1',
  outcome: 'YES',
  side: 'BUY',
  price: 0.485,
  size: 7,
  fee: 0.02,
  feeAsset: 'USDC',
  timestamp: Date.now(),
};

/* A book whose best ask (0.49) crosses a 0.50 BUY limit with full depth */
const deepBook: OrderBook = { bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.49, size: 50 }] };

describe('Engine fill flow (Steps A + B)', () => {
  it('does NOT notify the strategy when nothing filled', async () => {
    const h = buildHarness(deepBook, null);
    h.seedMarket(marketData());

    await h.processSignals();

    expect(h.wallet.calls).toBe(1); // order was sent
    expect(h.fills.length).toBe(0); // no fill → notifyFill must NOT run → no phantom position
  });

  it('notifies the strategy with the FILL price and size, not the request', async () => {
    const h = buildHarness(deepBook, realFill);
    h.seedMarket(marketData());

    await h.processSignals();

    expect(h.wallet.calls).toBe(1);
    expect(h.wallet.lastRequest?.price).toBe(0.5); // wallet received the request...
    expect(h.wallet.lastRequest?.size).toBe(10);
    expect(h.fills.length).toBe(1);
    expect(h.fills[0].price).toBe(0.485); // ...but the strategy was told the real fill
    expect(h.fills[0].size).toBe(7);
  });

  it('drops the order before sending when the book has no depth at the limit', async () => {
    // Best ask 0.60 is above the 0.50 BUY limit → nothing crossable
    const h = buildHarness({ bids: [{ price: 0.4, size: 50 }], asks: [{ price: 0.6, size: 50 }] }, realFill);
    h.seedMarket(marketData());

    await h.processSignals();

    expect(h.wallet.calls).toBe(0); // never sent
    expect(h.fills.length).toBe(0);
  });

  it('still routes (with a warning) when the book is thin but non-zero', async () => {
    // Only 5 shares visible below the 0.50 limit; the order wants 10
    const h = buildHarness(
      { bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.49, size: 5 }] },
      { ...realFill, size: 5 },
    );
    h.seedMarket(marketData());

    await h.processSignals();

    expect(h.wallet.calls).toBe(1); // sent — the wallet fills whatever is really there
    expect(h.fills.length).toBe(1);
    expect(h.fills[0].size).toBe(5);
  });

  it('drops the order when the market is not in the live cache', async () => {
    const h = buildHarness(deepBook, realFill);
    // NOTE: intentionally no seedMarket() call

    await h.processSignals();

    expect(h.wallet.calls).toBe(0);
    expect(h.fills.length).toBe(0);
  });
});
