# AGENTS.md — READ THIS FILE FIRST

This file binds every AI agent, model, copilot, and human collaborator working
in this repository, with the same force as `docs/TRANSFORMATION_HANDOFF.md`
section 0. If you are an AI and you were not told to read this file, you are
required to read it before writing any code, running any command, or touching
any state.

## FORBIDDEN — absolute, non-negotiable. Violations are critical incidents.

1. **FORBIDDEN: placing any real/live order** on Polymarket (or anywhere)
   without the owner's explicit, specific go-ahead for that action. LIVE
   orders require ALL of: `ENABLE_LIVE_TRADING=true`, `POLYMARKET_DRY_RUN=false`,
   and the owner's explicit approval for the exact trade being placed.
2. **FORBIDDEN: setting, editing, or filling in `ENABLE_LIVE_TRADING` or
   `POLYMARKET_DRY_RUN`** unless the owner explicitly instructed it in the
   current session. An empty `ENABLE_LIVE_TRADING=` means LIVE is disarmed —
   leave it that way.
3. **FORBIDDEN: any code path that pauses, resumes, removes, or creates a
   strategy runner / lane / wallet without a direct operator action.**
   `engine.pauseRunner` / `resumeRunner` / `removeRunner` / `addRunner` are
   wired ONLY to dashboard HTTP handlers operated by the owner. The owner's
   button pushes are IMPERIAL OPERATOR LAW and are never to be contravened
   by anything, period. No timer, scanner, risk system, or "smart" logic may
   change lane state autonomously.
4. **FORBIDDEN: fake data.** No `Math.random` prices/fills, no synthetic
   slippage, no fallback quotes, no simulated success. If real data is
   missing, throw and refuse.
5. **FORBIDDEN: secrets in output, logs, or git.** Credentials live in
   `.env` and `D:\master.env` (both gitignored). Never print, echo, commit,
   or copy their values.
6. **FORBIDDEN: rotating the Polymarket API keys.** Owner decision
   2026-11-10, permanent.
7. **FORBIDDEN: persisting LIVE credentials to disk** or re-introducing
   EVM / EIP-712 / HMAC signing. polyUSA signs with Ed25519 API keys,
   in-memory only.
8. **FORBIDDEN: weakening or skipping the verification gates** —
   `tsc --noEmit`, `vitest run`, `npm run lint` must pass before any change
   is declared done. Never delete or soften a test to make it pass.

## OPERATOR LAW — the governance model of this bot

- The owner's dashboard buttons (START/RUNNING, PAUSE, REMOVE, CREATE) are
  the ONLY authority over lane state. `engine.resumeRunner` additionally
  calls `strategy.onOperatorResume()` — the operator's START clears every
  software self-stop (drawdown breakers, loss cooldowns). The owner's START
  outranks all of them.
- A crashing strategy is isolated per-runner (`engine.tick` try/catch).
  Lanes never die, pause, or disappear on their own. Only the owner's
  button (or a wallet DELETE) removes a runner.
- Restarts must preserve operator state EXACTLY: dashboard-created wallets
  restore fully from `.runtime/wallets.db`; PAUSE choices survive restarts;
  a wallet removed from `config.yaml` can never resurrect (zombie guard).
- The KillSwitch blocks ORDERS only when the owner activates it. It never
  touches lane state.

## LIVE wiring facts (verified 2026-11-11)

- Every LIVE wallet (dashboard-created or config) is built through
  `WalletManager.createLiveWallet` → real polymarket.us account via
  `.env` polyUSA credentials (or per-wallet imported credentials,
  in-memory). LIVE lanes share the parent account's client.
- On creation the server immediately verifies the wire: it fetches the
  exchange balance and logs `LIVE WIRE VERIFIED` with the real USD figure.
- LIVE balances shown anywhere in the dashboard come from the exchange
  (`account.balances()`), refreshed every 15 s — never from a config number.
- Order path: strategy → OrderRouter → RiskEngine (kill switch, limits) →
  `PolymarketWallet.placeOrder` → polyUSA → `https://clob.polymarket.com`,
  preview-only until `POLYMARKET_DRY_RUN=false`.

## Verification gates (run all before declaring done)

```powershell
cd 'C:\Users\Device\GitReposMine\Polymarket-Trading-Bot'
npm install --include=dev
node node_modules\typescript\bin\tsc -p tsconfig.json --noEmit
node node_modules\vitest\vitest.mjs run   # run in background; foreground times out
npm run lint
```

See `docs/TRANSFORMATION_HANDOFF.md` for the full work order, verified API
facts, and known gaps. Line endings are CRLF — keep them.
