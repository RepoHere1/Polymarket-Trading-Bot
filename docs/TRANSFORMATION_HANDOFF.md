# Polymarket Bot: Transformation Handoff

This is the work order for finishing the move from simulated fills to real data.
Read section 0 before touching anything.

## 0. Safety rules (non-negotiable)

1. **Never place a real order** without an explicit go-ahead from the owner.
2. **LIVE stays OFF.** Keep `ENABLE_LIVE_TRADING` unset or not `true` in `.env` until Step F is complete and approved.
3. **No fake fills.** Do not add `Math.random`, `setTimeout` latency, synthetic slippage, or fallback prices. If real data is missing, throw and refuse.
4. **No secrets in output or git.** Credentials live in `.env` and `D:\master.env`, both gitignored. Never print values.
5. **Rotate exposed credentials.** The six scratch files `test_keys.js`, `test_matrix.js`, `test_new.js`, `test_raw.js`, `test_sdk.js`, `test_sdk2.js` hold hardcoded Polymarket US credentials. Their key was printed in a session log, so rotate it at polymarket.us/developer, then delete the files. They are now gitignored.
6. **Install with dev deps.** `NODE_ENV=production` drops `typescript`, `vitest`, `tsx`, and `eslint`. Use `npm install --include=dev`.
7. **Line endings are CRLF.** Keep them.
8. **The running bot (PID 13936) uses old code.** Rebuild and restart after changes. Paper balances are in memory, so a restart resets them.

## 1. Target behavior

One engine, two execution modes:

- **PAPER (dry run):** real Gamma market metadata, real CLOB L2 order books (`/book`), and the real taker-fee schedule. Orders are matched against the real book by a deterministic matcher (`src/paper_trading/book_matcher.ts`). A fill happens only if the book crosses the limit. Partial fills and no-fills are reported honestly.
- **LIVE:** real CLOB orders, signed with the owner's wallet key and submitted to `https://clob.polymarket.com`. Gated by `ENABLE_LIVE_TRADING=true`, the same risk engine, and explicit owner approval.

## 2. Verified facts (checked against live endpoints)

- Gamma `GET https://gamma-api.polymarket.com/markets` returns `clobTokenIds` (JSON string, index 0 = YES, 1 = NO), `bestBid`, `bestAsk`, `orderPriceMinTickSize`, `orderMinSize`, `feesEnabled`, and `feeSchedule {rate, exponent, takerOnly, rebateRate}`.
- CLOB `GET /book?token_id=` returns `bids` and `asks` as string price and size, sorted worst to best. Our parser sorts them correctly.
- CLOB `GET /fee-rate?token_id=` returns `{"base_fee": N}`. It does NOT return `fee_rate` or `fee_exponent`. The old parser read fields that never exist, so fees were always zero.
- Taker fee: `fee = C × feeRate × (p × (1 − p))^exponent`, in USDC, rounded to 5 decimals. Makers pay no fee. Use `feeSchedule.rate` and `exponent` from Gamma. Confirm what `base_fee` means before using it.
- The `polymarket-us` npm package uses a separate market catalog. A slug that Gamma serves returns `NotFound` there. Do not use it for this bot's markets.
- No EVM signing library is installed (no `ethers`, `viem`, or `@noble/curves`). LIVE needs one.

## 3. Current state

Done and verified in code:
- `src/paper_trading/book_matcher.ts`: `matchAgainstBook()` and `takerFeeUsdc()`. Tests in `tests/book_matcher.test.ts` (7 pass).
- `src/wallets/paper_wallet.ts`: fills against the live book, charges the real fee, rejects SELLs with no held shares, clamps SELL size to held shares, and throws when market data is missing. Tests in `tests/paper_wallet.test.ts` (6 pass).
- `src/wallets/wallet_manager.ts`: PAPER wallets get a lazy market-data provider, so startup order no longer matters. `createPaperWallet()` is used by the dashboard.
- `src/wallets/polymarket_wallet.ts`: LIVE throws and sends nothing.
- `src/reporting/dashboard_server.ts`: dashboard wallets are created through `createPaperWallet()`. LIVE creation is rejected with a clear message.
- Deleted: `fill_simulator.ts`, `slippage_model.ts`, `pnl_tracker.ts`, `test_vwap.ts`.



## 4. Remaining work, in order

Each step needs its own test before the next one starts.

**Step A: Engine uses real fill results.** `engine.ts` calls `notifyFill(order)` after `route()` returns true, even when nothing filled. Change it so `notifyFill` runs only with a real `OrderFill`, at the filled size and average price. Update `OrderRouter`, `TradeExecutor`, and `ExecutionWallet` to return that fill. Test: a no-fill must not create a strategy position.

**Step B: Strategy sizing against depth.** Strategies size from the midprice, not from the executable book. Check real liquidity: compare the desired size with book depth at the limit price using `matchAgainstBook`. Test: a thin book reduces or skips the order.

**Step C: Real market data only.** `market_fetcher.ts` derives `bid`/`ask` when Gamma leaves them empty (`yesPrice ± 0.02`, `± 0.01`). That's a synthetic fallback. Remove it. Skip markets without a real bid and ask, and log the skip count.

**Step D: Fee schedule.** Confirm what Gamma `feeSchedule.rate` and `exponent` mean per market, and whether `takerOnly` applies to our PAPER taker fills. Test against the documented Crypto table: 100 shares @ $0.50 = $1.75.

**Step E: Copy-trade delay.** `copySimDelaySeconds` in `config.yaml` is never used, and the copy-trade simulator is the same kind of theatre. Either wire it to the real trade timestamp and the book at that time, or label it as an estimate in the dashboard. Do not present it as a result.

**Step F: LIVE execution (blocked on owner input).** Requires:
1. The Polymarket account's wallet private key, supplied by the owner through `.env`. Never in code or chat.
2. An EVM signing library added with `npm install`, such as `ethers` or `viem`.
3. The CLOB L1 auth flow: `POST /auth/derive-api-key` with an EIP-712 `ClobAuth` signature, to get the L2 API key, secret, and passphrase.
4. Order EIP-712 signing against the CTF Exchange domain, then `POST /order`. Verify the domain, struct, and side encoding in the official docs before signing anything.
5. L2 HMAC headers (`POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`). The signature is `HMAC-SHA256(base64Decode(secret), timestamp + method + path + body)`, output as URL-safe base64.
6. A dry run that signs without sending, then one tiny live order only after explicit owner approval.

**Step G: Dashboard and cleanup.** Remove the remaining "simulated" labels, "copy-trade simulator" wording, and fake-fill text across `dashboard_server.ts` and `README.md`. Confirm no `Math.random` in `src/paper_trading` or `src/wallets`.

## 5. Known gaps (do not hide these)

- LIVE cannot place orders. This is intentional.
- The whale scanner may be stuck. Its first batch hadn't finished after about 16 minutes, and `marketsPerScan: 50` doesn't cap the loop.
- `dashboard_server.ts` is about 257 KB in one file. Split it before major changes.
- `find_fees.ts` and the `test_*.js` scratch files are leftovers. Delete them after rotating the exposed key.
- The running bot (PID 13936) still runs the old simulator until restarted.

## 6. How to verify

```powershell
cd 'C:\Users\Device\GitReposMine\Polymarket-Trading-Bot'
npm install --include=dev
node node_modules\typescript\bin\tsc -p tsconfig.json --noEmit
node node_modules\vitest\vitest.mjs run
npm run lint
```

Run long commands in the background and poll their output files. A foreground `vitest` run timed out at 30 seconds on this machine.
