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
});
