import { describe, it, expect } from 'vitest';
import { polyUsaClientFactory } from '../src/wallets/polymarket_wallet';
import { WalletManager } from '../src/wallets/wallet_manager';
import { WalletConfig } from '../src/types';

const liveConfig: WalletConfig = { id: 'live_dash', mode: 'LIVE', strategy: 'ai_forecast', capital: 50 };

describe('LIVE wallet creation wiring (dashboard)', () => {
  it('polyUsaClientFactory caches one client instance (imported creds, no per-order rebuild)', () => {
    const factory = polyUsaClientFactory('key-id-123', 'secret-456');
    const a = factory();
    const b = factory();
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });

  it('WalletManager.createLiveWallet returns a LIVE-mode wallet without imported creds', () => {
    const wm = new WalletManager();
    const w = wm.createLiveWallet(liveConfig, 'ai_forecast');
    const s = w.getState();
    expect(s.mode).toBe('LIVE');
    expect(s.walletId).toBe('live_dash');
    expect(s.capitalAllocated).toBe(50);
  });

  it('WalletManager.createLiveWallet accepts an imported-credential client factory', () => {
    const wm = new WalletManager();
    const factory = polyUsaClientFactory('key-id-123', 'secret-456');
    const w = wm.createLiveWallet(liveConfig, 'ai_forecast', factory);
    expect(w.getState().mode).toBe('LIVE');
  });

  it('registerWallet wires a LIVE config wallet even when the server is NOT armed (orders stay gated at the wallet)', () => {
    const prevKey = process.env.POLYMARKET_API_KEY;
    const prevSecret = process.env.POLYMARKET_API_SECRET;
    const prevArm = process.env.ENABLE_LIVE_TRADING;
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_API_SECRET = 'test-secret';
    delete process.env.ENABLE_LIVE_TRADING;
    try {
      const wm = new WalletManager();
      wm.registerWallet(
        { id: 'live_unarmed', mode: 'LIVE', strategy: 'ai_forecast', capital: 50 },
        'ai_forecast',
        false,
      );
      expect(wm.getWallet('live_unarmed')?.getState().mode).toBe('LIVE');
    } finally {
      if (prevKey === undefined) delete process.env.POLYMARKET_API_KEY;
      else process.env.POLYMARKET_API_KEY = prevKey;
      if (prevSecret === undefined) delete process.env.POLYMARKET_API_SECRET;
      else process.env.POLYMARKET_API_SECRET = prevSecret;
      if (prevArm === undefined) delete process.env.ENABLE_LIVE_TRADING;
      else process.env.ENABLE_LIVE_TRADING = prevArm;
    }
  });
});
