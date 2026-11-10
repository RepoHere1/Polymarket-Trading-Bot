import { OrderFill, OrderRequest } from '../types';
import { WalletManager } from '../wallets/wallet_manager';
import { RiskEngine } from '../risk/risk_engine';
import { TradeExecutor } from './trade_executor';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

export class OrderRouter {
  constructor(
    private readonly walletManager: WalletManager,
    private readonly riskEngine: RiskEngine,
    private readonly tradeExecutor: TradeExecutor,
  ) {}

  /**
   * Routes an order through risk checks to the wallet.
   * Returns the real OrderFill on execution, or null when the order was
   * dropped (wallet missing, risk rejected) or simply did not fill
   * (limit never crossed the book). Callers must treat null as "no fill".
   */
  async route(order: OrderRequest): Promise<OrderFill | null> {
    const wallet = this.walletManager.getWallet(order.walletId);
    if (!wallet) {
      logger.warn({ walletId: order.walletId }, 'Wallet not found');
      consoleLog.warn('ORDER', `Wallet ${order.walletId} not found — order dropped`, {
        walletId: order.walletId,
        marketId: order.marketId,
      });
      return null;
    }

    const state = wallet.getState();
    const risk = this.riskEngine.check(order, state);
    if (!risk.ok) {
      logger.warn({ walletId: order.walletId, reason: risk.reason }, 'Risk check failed');
      consoleLog.warn('RISK', `Risk rejected: ${risk.reason} [${order.walletId}] ${order.side} ${order.outcome} ×${order.size}`, {
        walletId: order.walletId,
        marketId: order.marketId,
        reason: risk.reason,
        side: order.side,
        outcome: order.outcome,
        price: order.price,
        size: order.size,
      });
      return null;
    }

    return this.tradeExecutor.execute(order, wallet);
  }
}
