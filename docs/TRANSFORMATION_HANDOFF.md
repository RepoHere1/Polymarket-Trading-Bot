# Polymarket Bot: Transformation Handoff

This is the work order for finishing the move from simulated fills to real data.
Read section 0 before touching anything.

## 0. Safety rules (non-negotiable)

1. **Never place a real order** without an explicit go-ahead from the owner.
2. **LIVE stays OFF.** Keep `ENABLE_LIVE_TRADING` unset or not `true` in `.env` until Step F is complete and approved.
3. **No fake fills.** Do not add `Math.random`, `setTimeout` latency, synthetic slippage, or fallback prices. If real data is missing, throw and refuse.
4. **No secrets in output or git.** Credentials live in `.env` and `D:\master.env`, both gitignored. Never print values.
5. **No key rotation.** Owner decision 2026-11-10: forget the exposure concern permanently. The Polymarket US API keys (`POLYMARKET_API_KEY` / `POLYMARKET_API_SECRET` / `POLYMARKET_API_PASSPHRASE`) are the account's trading keys, already in `D:\master.env` and `.env`. Never print values, never commit them. The scratch files that hardcoded copies were deleted 2026-11-10.
6. **Install with dev deps.** `NODE_ENV=production` drops `typescript`, `vitest`, `tsx`, and `eslint`. Use `npm install --include=dev`.
7. **Line endings are CRLF.** Keep them.
8. **Rebuild and restart the bot after code changes.** Paper balances are in memory, so a restart resets them. Done 2026-11-10: old process (PID 13936) stopped; restarted via `start_bot.ps1` (PAPER mode, PID 10936) on the transformed build `e9241f0`. Expect a new PID after the next restart.

## 1. Target behavior

One engine, two execution modes:

- **PAPER (dry run):** real Gamma market metadata, real CLOB L2 order books (`/book`), and the real taker-fee schedule. Orders are matched against the real book by a deterministic matcher (`src/paper_trading/book_matcher.ts`). A fill happens only if the book crosses the limit. Partial fills and no-fills are reported honestly.
- **LIVE:** real CLOB orders, signed with the owner's wallet key and submitted to `https://clob.polymarket.com`. Gated by `ENABLE_LIVE_TRADING=true`, the same risk engine, and explicit owner approval.

## 2. Verified facts (checked against live endpoints)

- Gamma `GET https://gamma-api.polymarket.com/markets` returns `clobTokenIds` (JSON string, index 0 = YES, 1 = NO), `bestBid`, `bestAsk`, `orderPriceMinTickSize`, `orderMinSize`, `feesEnabled`, and `feeSchedule {rate, exponent, takerOnly, rebateRate}`.
- CLOB `GET /book?token_id=` returns `bids` and `asks` as string price and size, sorted worst to best. Our parser sorts them correctly.
- CLOB `GET /fee-rate?token_id=` returns `{"base_fee": N}`. It does NOT return `fee_rate` or `fee_exponent`. The old parser read fields that never exist, so fees were always zero.
- Taker fee: `fee = C × feeRate × (p × (1 − p))^exponent`, in USDC, rounded to 5 decimals. Makers pay no fee. Use `feeSchedule.rate` and `exponent` from Gamma. Confirm what `base_fee` means before using it.
- Confirmed live 2026-11-10 (Step D): crypto markets return `feeType: "crypto_fees_v2"` with `feeSchedule { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 }`; politics markets use rate 0.04, exponent 1. Check: 100 shares @ $0.50 → 100 × 0.07 × (0.5 × 0.5)^1 = $1.75, matching the documented crypto table and the `takerFeeUsdc()` test vector. `takerOnly: true` means taker fills pay — every PAPER fill crosses the book as a taker, so the fee always applies; makers pay 0. Gamma's `makerBaseFee`/`takerBaseFee` (e.g. 1000) are NOT the fee-rate fields and are ignored, as is CLOB `/fee-rate` `base_fee`.
- The `polymarket-us` npm package (v0.1.1, deps `@noble/ed25519` + `ws`) is the WRONG source for this bot's market catalog (a slug that Gamma serves returns `NotFound` there), but it is the RIGHT client for polyUSA account + orders: `client.orders.create()`, `client.portfolio`, `client.account`, typed errors, WebSockets.
- CORRECTED 2026-11-10: no EVM signing library is needed and none will be installed. polyUSA LIVE auth = API keys created by the owner at polymarket.us/developer (already in `D:\master.env` / `.env`), Ed25519 signature over `timestamp + method + path` using the base64-decoded secret (first 32 bytes), `X-PM-Access-Key` header family, base `https://api.polymarket.us`. This was proven working by the scratch auth probes (200s on `/me`, balances, positions) before they were deleted.

## 3. Current state

Done and verified in code:
- `src/paper_trading/book_matcher.ts`: `matchAgainstBook()` and `takerFeeUsdc()`. Tests in `tests/book_matcher.test.ts` (7 pass).
- `src/wallets/paper_wallet.ts`: fills against the live book, charges the real fee, rejects SELLs with no held shares, clamps SELL size to held shares, and throws when market data is missing. Tests in `tests/paper_wallet.test.ts` (6 pass).
- `src/wallets/wallet_manager.ts`: PAPER wallets get a lazy market-data provider, so startup order no longer matters. `createPaperWallet()` is used by the dashboard.
- `src/wallets/polymarket_wallet.ts`: LIVE trades via the polyUSA SDK (Step F, 2026-11-10); dry-run preview is the default.
- `src/reporting/dashboard_server.ts`: dashboard creates PAPER wallets via `createPaperWallet()` and LIVE wallets via `WalletManager.createLiveWallet()` when `ENABLE_LIVE_TRADING=true` (otherwise 403 with arm instructions). The create-wallet form accepts optional imported polyUSA API credentials (`polyUsaClientFactory`, in-memory only — never logged/echoed/persisted); blank fields fall back to `.env`. Seed phrases / private keys are intentionally not accepted: polyUSA signs with Ed25519 API keys. Paper cash balances are settable per wallet (detail → Settings → Paper Balance; `PATCH /api/wallets/:id` with `{ balance }`, PAPER only — LIVE balance is exchange truth).
- Deleted: `fill_simulator.ts`, `slippage_model.ts`, `pnl_tracker.ts`, `test_vwap.ts`.

Done 2026-11-10 (second pass — Steps A, B, C, D, E, G):
- Step A: `OrderRouter.route()` and `TradeExecutor.execute()` return `OrderFill | null`. `engine.ts` calls `notifyFill` only on a real fill, at the fill's average price and filled size, and logs the real fee. Entry and exit no-fills are logged as warnings, never as fills. Tests: `tests/order_router.test.ts` (4), `tests/engine_fill_flow.test.ts` (5).
- Step B: engine `checkDepth()` walks the live CLOB book via `matchAgainstBook` before routing each entry order. Zero visible depth at the limit drops the order with a `DEPTH` warning; thin depth is flagged and the wallet then fills whatever is really there. Costs one extra `/book` call per entry order.
- Step C: `market_fetcher.ts` no longer fabricates bid/ask from `yesPrice ± 0.02 / ± 0.01`. Markets without a real two-sided quote (missing, zero, equal, or crossed) are skipped and the skip count is logged. Tests: `tests/market_fetcher.test.ts` (3).
- Step D: fee schedule confirmed against live Gamma (see section 2). No code change needed.
- Steps E + G: copy-trade simulator relabeled everywhere as an offline ESTIMATE (dashboard view/button/table, `config.yaml` comment, `whale_types.ts` comments, README). API field names (`simulatedPnlUsd` etc.) unchanged for compatibility. Verified: no `Math.random` in `src/paper_trading` or `src/wallets`.



Corrected 2026-11-10 (third pass — credentials model):
- The LIVE model is polyUSA API keys, NOT an EVM wallet. Credentials already exist: `POLYMARKET_API_KEY` / `POLYMARKET_API_SECRET` / `POLYMARKET_API_PASSPHRASE` in `D:\master.env` and `.env`. The `polymarket-us@0.1.1` SDK is already a dependency (`@noble/ed25519`, `ws`). Owner cancelled the key-rotation task permanently; the scratch credential probes (`test_*.js`, `find_fees.ts`) were deleted.

## 4. Remaining work, in order

**Status 2026-11-10: A ✅ · B ✅ · C ✅ · D ✅ · E ✅ (labeled as estimate) · G ✅ — only F remains. F is now correctly specced (polyUSA SDK; credentials on hand; nothing left to install) but still requires the owner's explicit go-ahead before any real order is sent. Ops: bot restarted onto the new build (PID 10936, PAPER mode, `start_bot.ps1`); phantom paper balances were reset by the restart, as intended.**

Each step needs its own test before the next one starts.

**Step A: Engine uses real fill results.** ✅ DONE. `engine.ts` calls `notifyFill(order)` after `route()` returns true, even when nothing filled. Change it so `notifyFill` runs only with a real `OrderFill`, at the filled size and average price. Update `OrderRouter`, `TradeExecutor`, and `ExecutionWallet` to return that fill. Test: a no-fill must not create a strategy position.

**Step B: Strategy sizing against depth.** ✅ DONE (engine-level `checkDepth()`; strategies unchanged). Strategies size from the midprice, not from the executable book. Check real liquidity: compare the desired size with book depth at the limit price using `matchAgainstBook`. Test: a thin book reduces or skips the order.

**Step C: Real market data only.** ✅ DONE. `market_fetcher.ts` derives `bid`/`ask` when Gamma leaves them empty (`yesPrice ± 0.02`, `± 0.01`). That's a synthetic fallback. Remove it. Skip markets without a real bid and ask, and log the skip count.

**Step D: Fee schedule.** ✅ DONE (confirmed live; no code change). Confirm what Gamma `feeSchedule.rate` and `exponent` mean per market, and whether `takerOnly` applies to our PAPER taker fills. Test against the documented Crypto table: 100 shares @ $0.50 = $1.75.

**Step E: Copy-trade delay.** ✅ DONE (labeled as estimate). `copySimDelaySeconds` in `config.yaml` is never used, and the copy-trade simulator is the same kind of theatre. Either wire it to the real trade timestamp and the book at that time, or label it as an estimate in the dashboard. Do not present it as a result. — It is now labeled "Copy-Trade Estimate / offline replay — not live fills" across the dashboard, config, types, and README. `copySimDelaySeconds` still only documents an assumption; wiring real delayed fills needs book history we do not store.

**Step F: LIVE execution (awaiting owner go-ahead).** ✅ IMPLEMENTED 2026-11-10 — `src/wallets/polymarket_wallet.ts` now trades via the polyUSA SDK; typecheck, lint, and all 181 tests green (`tests/polymarket_wallet.test.ts` covers it). The earlier EVM/EIP-712/HMAC spec was WRONG — that is the international CLOB model; this account is polyUSA. Status of the plan:
1. Credentials: already present — `POLYMARKET_API_KEY` / `POLYMARKET_API_SECRET` / `POLYMARKET_API_PASSPHRASE` in `.env` and `D:\master.env` (owner-created at polymarket.us/developer). Nothing to install or supply.
2. Client: the already-installed `polymarket-us@0.1.1` SDK (deps `@noble/ed25519`, `ws`). Auth proven by the scratch probes: Ed25519 sign of `timestamp + method + path`, base64 secret decoded to a 32-byte seed, `X-PM-Access-Key` header family, base `https://api.polymarket.us`.
3. ✅ DONE. Implemented on `new PolymarketUS({ keyId, secretKey })` with `orders.create(CreateOrderParams)`: YES/NO×BUY/SELL mapped to the four `ORDER_INTENT_*` values, limit IOC, integer share quantities, SELL clamped to held shares, price string to 3 decimals. Balance is exchange truth (`account.balances()`, USD buying power, 10s TTL, forced pre-trade). Markets are verified against the polyUSA catalog (`markets.retrieveBySlug`) and the miss is cached; the Gamma→slug lookup uses the shared OrderbookStream cache via WalletManager.
4. ✅ DONE by design: DRY RUN IS THE DEFAULT. An order is actually sent only when `POLYMARKET_DRY_RUN === 'false'`; otherwise `orders.preview()` validates server-side and nothing is placed. No executions in the response → no fill reported (honest fills only).
5. ONE tiny live order only after explicit owner approval. No EVM library, no EIP-712, no HMAC — do not reintroduce them. Rebuild and restart the bot before arming LIVE.

**Step G: Dashboard and cleanup.** ✅ DONE. Remove the remaining "simulated" labels, "copy-trade simulator" wording, and fake-fill text across `dashboard_server.ts` and `README.md`. Confirm no `Math.random` in `src/paper_trading` or `src/wallets`.

## 5. Known gaps (do not hide these)

- Exit fills do NOT call `notifyFill` (pre-existing engine behavior, kept intentionally). Momentum and copy-trade strategies ignore SELL fills by design, but the spread strategy's inventory is not decremented when an exit SELL fills — track as future work.
- The engine depth check (Step B) adds one CLOB `/book` fetch per entry order. Batch or cache if it becomes hot.
- Gamma pagination terminates via a 422: the `/markets` endpoint rejects deep offsets (observed at offset 2100), so every poll logs one `Gamma API page request failed` ERROR (status 422, offset 2100) and completes with ~1,807 markets over 21 pages. Pre-existing behavior — the page loop breaks on failure — not a Step C regression. If coverage beyond ~2,100 markets is ever needed, switch to a keyset/date filter instead of offset paging.

- LIVE wallet code is implemented (Step F, 2026-11-10) but cannot send a real order unless `ENABLE_LIVE_TRADING=true` AND `POLYMARKET_DRY_RUN=false` AND the owner has given explicit go-ahead; the default is preview-only dry run. Known gap: the polyUSA `UserPosition` object has no clean YES/NO outcome mapping, so LIVE open positions track this wallet's own fills rather than `portfolio.positions()`. Dashboard LIVE wallet creation is wired (2026-11-10, third pass): armed servers create real `PolymarketWallet`s; imported API credentials live only in the in-memory client factory and are lost on restart by design.
- The whale scanner may be stuck. Its first batch hadn't finished after about 16 minutes, and `marketsPerScan: 50` doesn't cap the loop.
- `dashboard_server.ts` is about 257 KB in one file. Split it before major changes.
- RESOLVED 2026-11-10: owner cancelled the rotation permanently (keys are the polyUSA account keys in `D:\master.env`; exposure concern dropped). `find_fees.ts` (tracked; removed via git rm) and the six `test_*.js` probes (untracked) deleted. Credentials now live only in `.env` / `D:\master.env`.
- RESOLVED 2026-11-10 14:03: the bot was restarted onto the new build (old PID 13936 stopped, new PID 10936 via `start_bot.ps1`, PAPER mode, LIVE wallet refused as designed). Verified from live logs: ~292 markets skipped per poll for missing real two-sided quotes (Step C active), `PAPER SELL rejected: no shares held` (honest wallets — the phantom-cash arb is gone), dashboard returns 200 and serves the "Copy-Trade Estimate" wording.

## 6. How to verify

```powershell
cd 'C:\Users\Device\GitReposMine\Polymarket-Trading-Bot'
npm install --include=dev
node node_modules\typescript\bin\tsc -p tsconfig.json --noEmit
node node_modules\vitest\vitest.mjs run
npm run lint
```

Run long commands in the background and poll their output files. A foreground `vitest` run timed out at 30 seconds on this machine.
