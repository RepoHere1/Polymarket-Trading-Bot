import { describe, it, expect } from 'vitest';
import { OrderRouter } from '../src/execution/order_router';
import { RiskEngine } from '../src/risk/risk_engine';
import { KillSwitch } from '../src/risk/kill_switch';
import { TradeExecutor } from '../src/execution/trade_executor';
import { WalletManager } from '../src/wallets/wallet_manager';
import { OrderFill, OrderRequest, WalletState } from '../src/types';

interface PlaceOrderRequest {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

class StubWallet {
  public called = false;
  public lastRequest: PlaceOrderRequest | null = null;
  constructor(
    private state: WalletState,
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
    this.called = true;
    this.lastRequest = request;
    return this.nextFill;
  }
}

function walletState(over: Partial<WalletState> = {}): WalletState {
  return {
    walletId: 'wallet_1',
    mode: 'PAPER',
    assignedStrategy: 'momentum',
    capitalAllocated: 1000,
    availableBalance: 1000,
    openPositions: [],
    realizedPnl: 0,
    riskLimits: {
      maxPositionSize: 100,
      maxExposurePerMarket: 200,
      maxDailyLoss: 100,
      maxOpenTrades: 5,
      maxDrawdown: 0.2,
    },
    ...over,
  };
}

function order(over: Partial<OrderRequest> = {}): OrderRequest {
  return {
    walletId: 'wallet_1',
    marketId: 'POLY-EXAMPLE',
    outcome: 'YES',
    side: 'BUY',
    price: 0.5,
    size: 10,
    strategy: 'momentum',
    ...over,
  };
}

const realFill: OrderFill = {
  orderId: 'fill-1',
  marketId: 'POLY-EXAMPLE',
  outcome: 'YES',
  side: 'BUY',
  price: 0.495,
  size: 8,
  fee: 0.0139,
  feeAsset: 'USDC',
  timestamp: Date.now(),
};

function makeRouter(stub: StubWallet): OrderRouter {
  const manager = new WalletManager();
  manager.registerExternalWallet(stub.getState().walletId, stub);
  return new OrderRouter(manager, new RiskEngine(new KillSwitch()), new TradeExecutor());
}

describe('OrderRouter (returns real fill results)', () => {
  it('returns the wallet OrderFill when the order executes', async () => {
    const stub = new StubWallet(walletState(), realFill);
    const result = await makeRouter(stub).route(order());
    expect(stub.called).toBe(true);
    expect(result).toEqual(realFill);
  });

  it('returns null (no fill) when the wallet reports nothing filled', async () => {
    const stub = new StubWallet(walletState(), null);
    const result = await makeRouter(stub).route(order());
    expect(stub.called).toBe(true); // the order WAS sent to the wallet...
    expect(result).toBeNull(); // ...but nothing filled — callers must not treat this as success
  });

  it('returns null when the wallet does not exist', async () => {
    const manager = new WalletManager();
    const router = new OrderRouter(manager, new RiskEngine(new KillSwitch()), new TradeExecutor());
    expect(await router.route(order({ walletId: 'missing' }))).toBeNull();
  });

  it('returns null and never sends when risk rejects', async () => {
    const stub = new StubWallet(
      walletState({ riskLimits: { maxPositionSize: 1, maxExposurePerMarket: 200, maxDailyLoss: 100, maxOpenTrades: 5, maxDrawdown: 0.2 } }),
      realFill,
    );
    const result = await makeRouter(stub).route(order({ size: 10 }));
    expect(result).toBeNull();
    expect(stub.called).toBe(false);
  });
});
