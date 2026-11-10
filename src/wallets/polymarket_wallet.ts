import { WalletConfig, WalletState, TradeRecord, OrderFill } from '../types';
import { logger } from '../reporting/logs';

/**
 * LIVE wallet. Fails closed: it does NOT sign or submit orders yet.
 * Real CLOB submission needs an EIP-712 signer key and an L2 HMAC client,
 * neither of which is configured. Until then every LIVE order is rejected loudly.
 */
export class PolymarketWallet {
  private state: WalletState;
  private readonly trades: TradeRecord[] = [];

  constructor(config: WalletConfig, assignedStrategy: string) {
    this.state = {
      walletId: config.id,
      mode: 'LIVE',
      assignedStrategy,
      capitalAllocated: config.capital,
      availableBalance: config.capital,
      openPositions: [],
      realizedPnl: 0,
      riskLimits: {
        maxPositionSize: config.riskLimits?.maxPositionSize ?? 100,
        maxExposurePerMarket: config.riskLimits?.maxExposurePerMarket ?? 200,
        maxDailyLoss: config.riskLimits?.maxDailyLoss ?? 100,
        maxOpenTrades: config.riskLimits?.maxOpenTrades ?? 5,
        maxDrawdown: config.riskLimits?.maxDrawdown ?? 0.2,
      },
    };
  }

  getState(): WalletState {
    return { ...this.state, openPositions: [...this.state.openPositions] };
  }

  getTradeHistory(): TradeRecord[] {
    return [...this.trades];
  }

  updateBalance(delta: number): void {
    this.state.availableBalance += delta;
  }

  async placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<OrderFill | null> {
    logger.error(
      { walletId: this.state.walletId, marketId: request.marketId },
      'LIVE order rejected: CLOB signing is not implemented. No order was sent.',
    );
    throw new Error(
      `LIVE wallet ${this.state.walletId}: order signing not implemented — no order sent`,
    );
  }
}
