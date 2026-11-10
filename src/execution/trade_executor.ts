import { OrderFill, OrderRequest } from '../types';
import { ExecutionWallet } from '../wallets/wallet_manager';

export class TradeExecutor {
  /**
   * Executes an order and returns the REAL fill result: an OrderFill at the
   * average execution price and filled size, or null when nothing filled
   * (limit not crossed / no depth). Never fabricates a fill.
   */
  async execute(order: OrderRequest, wallet: ExecutionWallet): Promise<OrderFill | null> {
    return wallet.placeOrder({
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      price: order.price,
      size: order.size,
    });
  }
}
