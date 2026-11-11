import { describe, it, expect } from 'vitest';
import {
  PolymarketWallet,
  polyUsaClientFactory,
  type PolymarketClientLike,
} from '../src/wallets/polymarket_wallet';
import { WalletManager } from '../src/wallets/wallet_manager';
import { WalletConfig } from '../src/types';

function stubClient(usd: number, execs?: object[]): PolymarketClientLike {
  return {
    orders: {
      preview: async () => ({}),
      create: async () => ({ id: 'ord-1', executions: execs ?? [] }),
    },
    account: { balances: async () => ({ balances: [{ currency: 'USD', buyingPower: usd }] }) },
    portfolio: { positions: async () => ({ positions: [] }) },
    markets: { retrieveBySlug: async () => ({}) },
  } as unknown as PolymarketClientLike;
}

const laneEnv = { ENABLE_LIVE_TRADING: 'true', POLYMARKET_DRY_RUN: 'false' } as NodeJS.ProcessEnv;

function makeLane(budget: number, client: PolymarketClientLike): PolymarketWallet {
  const config: WalletConfig = { id: 'lane_a', mode: 'LIVE_LANE', strategy: 'test', capital: budget };
  return new PolymarketWallet(config, 'test', {
    clientFactory: () => client,
    resolveSlug: () => 'market-slug',
    budgetCap: budget,
    env: laneEnv,
  });
}

describe('LIVE lane wallets (budget sub-allocation on one account)', () => {
  it('caps a lane to its budget even when the account is rich', async () => {
    const lane = makeLane(50, stubClient(1000));
    await lane.refreshState(true);
    const s = lane.getState();
    expect(s.mode).toBe('LIVE_LANE');
    expect(s.availableBalance).toBe(50); // min(exchange 1000, budget 50)
  });

  it('charges fills to the lane ledger, not the account balance', async () => {
    const lane = makeLane(
      50,
      stubClient(1000, [
        { lastShares: '10', lastPx: { value: '0.50' }, commissionNotionalCollected: { value: '0.175' } },
      ]),
    );
    await lane.refreshState(true);
    const fill = await lane.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.6, size: 10 });
    expect(fill).not.toBeNull();
    // ledger: 50 − (0.50×10) − 0.175 fee = 44.825, even though the exchange reports 1000
    expect(lane.getState().availableBalance).toBeCloseTo(44.825, 6);
    await lane.refreshState(true);
    expect(lane.getState().availableBalance).toBeCloseTo(44.825, 6);
    // exchange truth stays reachable for budget checks
    expect(await lane.getExchangeUsdBalance()).toBe(1000);
  });

  it('drops a BUY that exceeds the lane budget remaining', async () => {
    const lane = makeLane(50, stubClient(1000));
    await lane.refreshState(true);
    const tooBig = await lane.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.9, size: 60 });
    expect(tooBig).toBeNull();
  });

  it('WalletManager wires lanes to the parent account and tracks budgets', () => {
    const manager = new WalletManager();
    const account = manager.createLiveWallet(
      { id: 'acct_1', mode: 'LIVE', strategy: 'test', capital: 1000 },
      'test',
      polyUsaClientFactory('key-1', 'secret-1'),
    );
    manager.addWallet(account);

    const lane = manager.createLiveLaneWallet(
      'acct_1',
      { id: 'lane_a', mode: 'LIVE_LANE', strategy: 'test', capital: 200 },
      'test',
    );
    manager.addWallet(lane);
    manager.registerLiveLane('acct_1', 'lane_a', 200);

    expect(lane.getState().mode).toBe('LIVE_LANE');
    expect(lane.getState().capitalAllocated).toBe(200);
    expect(manager.getLiveLanes('acct_1')).toEqual([{ walletId: 'lane_a', budget: 200 }]);
    expect(manager.liveLaneParent('lane_a')).toBe('acct_1');
    expect(manager.liveLaneParent('acct_1')).toBeUndefined();

    manager.removeWallet('lane_a');
    expect(manager.getLiveLanes('acct_1')).toEqual([]);

    expect(() =>
      manager.createLiveLaneWallet('missing', { id: 'lane_x', mode: 'LIVE_LANE', strategy: 'test', capital: 10 }, 'test'),
    ).toThrow(/not found/i);
  });

  it('clamps a lane balance to the account balance when the account is poorer than the budget', async () => {
    const lane = makeLane(50, stubClient(20));
    await lane.refreshState(true);
    expect(lane.getState().availableBalance).toBe(20); // min(exchange 20, budget 50)
  });
});
