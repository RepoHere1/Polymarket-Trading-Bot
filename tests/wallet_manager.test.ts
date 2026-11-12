import { describe, it, expect } from 'vitest';
import { WalletManager } from '../src/wallets/wallet_manager';

const walletConfig = {
  id: 'wallet_1',
  mode: 'PAPER' as const,
  strategy: 'momentum',
  capital: 500,
};

describe('WalletManager', () => {
  it('registers paper wallets', () => {
    const manager = new WalletManager();
    manager.registerWallet(walletConfig, walletConfig.strategy, false);
    const wallets = manager.listWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0].mode).toBe('PAPER');
  });

  it('wires live wallets even when not enabled - ONE LIVE: registration is instant, orders stay gated at the wallet (owner order 2026-11-11)', () => {
    const prevKey = process.env.POLYMARKET_API_KEY;
    const prevSecret = process.env.POLYMARKET_API_SECRET;
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_API_SECRET = 'test-secret';
    try {
      const manager = new WalletManager();
      manager.registerWallet(
        { ...walletConfig, id: 'live_1', mode: 'LIVE' },
        walletConfig.strategy,
        false,
      );
      const wallets = manager.listWallets();
      expect(wallets).toHaveLength(1);
      expect(wallets[0].mode).toBe('LIVE');
    } finally {
      if (prevKey === undefined) delete process.env.POLYMARKET_API_KEY;
      else process.env.POLYMARKET_API_KEY = prevKey;
      if (prevSecret === undefined) delete process.env.POLYMARKET_API_SECRET;
      else process.env.POLYMARKET_API_SECRET = prevSecret;
    }
  });
});
