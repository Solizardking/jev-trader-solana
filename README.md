# jev-trader-solana

A **dry-run** multi-venue JEV taker trader for SOL on Solana, built by
[Clawd](https://github.com/Solizardking) 🦞

A **dry-run** multi-venue JEV taker trader for SOL on Solana:

- **Spot:** Jupiter + DFlow SOL-USDC quotes, deterministic best-price routing
  in code (buys hit the lowest ask, sells hit the highest bid).
- **Perps:** Imperial Phoenix-routed SOL perps, 1x only, observe/paper mode —
  simulated fills, funding accrual, unrealized PnL.

One JEV decision request per cycle picks the **operation**
(`BUY_SPOT` / `SELL_SPOT` / `LONG_PERP` / `SHORT_PERP` / `HOLD` / `PAUSE`)
plus a slippage-tolerance target (`s10`/`s25`/`s50`). JEV supplies typed
judgments/probabilities only. Deterministic code handles routing, sizing,
and risk. **Nothing is signed, nothing is submitted, no wallet is touched —
dry run only.**

## Run

```bash
cd jev-trader-solana
npm install

# dry-run trader (mock JEV stand-in, honest label)
MODEL=mock VENUE=multi DRY_RUN=true bun run src/index.ts

# dry-run trader (real JEV through TypeSafe; see "JEV access" below)
JEV_BIN=./scripts/jev-bridge.py TYPESAFE_API_KEY=... \
  MODEL=jev VENUE=multi DRY_RUN=true bun run src/index.ts

# dashboard
cd web && npm install && npx next build && npx next start -p 3001
# NEXT_PUBLIC_API_URL points at the trader's :3000 (same-origin by default)
```

No Solana RPC is needed. The multi-venue trader never reads the Phoenix spot
book and never touches a wallet.

## JEV access

The trader shells out to a JEV bridge CLI and parses the `answers` JSON it
prints to stdout:

```
jev-bridge.py ask --state "<state text>" --questions '{"op": {...}}' [--model jev-latest]
```

- `scripts/jev-bridge.py` is the public bridge. It calls
  `POST https://api.typesafe.ai/v1/systemone` with your
  `TYPESAFE_API_KEY` env var. Point the trader at it with
  `JEV_BIN=./scripts/jev-bridge.py`.
- Any executable honoring the same `ask --state --questions --model`
  contract works — the trader reads `JEV_BIN` at call time.
- `MODEL=mock` selects an honest mock stand-in for development without
  TypeSafe access.
- Any bridge failure or invalid answer fails closed: the trader emits
  `PAUSE`, never a trade.

## DFlow quotes

`src/dflow.ts` shells out to a DFlow quote CLI (a Python `urllib` client
hitting the DFlow quote API). Point it at yours with `DFLOW_QUOTE_BIN`;
it is invoked as `python3 <bin> <inputMint> <outputMint> <amountAtomic>`
and must print JSON containing `bid` and `ask`.

## Env knobs

`CYCLE_MS` (5000), `TRADE_SIZE_SOL` (0.1), `MAX_POSITION_SOL` (1),
`PERP_SIZE_SOL` (0.1), `MAX_PERP_SOL` (0.5), `SPOT_FEE_BPS` (5),
`PERP_FEE_BPS` (5), `BANKROLL_USD` (100),
`COINGECKO_STALE_MS` (300000), `JEV_TIMEOUT_MS` (30000),
`DFLOW_SUBPROC_TIMEOUT_MS` (15000), `JEV_MODEL_ID` (jev-latest).

These are development scaffolding, not approved live terms. Live trading
needs explicit approval of wallet, venue, sides, size limits, and risk
policy.

Legacy/unused knobs (kept for config-shape compatibility only, setting them
changes nothing): `PRIVATE_KEY` — read but never consumed; no code path
loads a wallet, builds a transaction, or signs. `PRIORITY_FEE_MICROLAMPORTS`
— no live transactions exist in this build; the dry-run simulator always
reports `feeSol: 0`.

## Tests

Two tiers:

- `npm test` — unit/dry tier. Runs every `scripts/test-*.ts` via bun
  (mock/deterministic where possible) and then `tsc --noEmit`; fails on
  any failure. The live Jev bridge cycle in `test-decision.ts` is
  best-effort here: if the bridge is unreachable it logs SKIP and the
  suite still passes (fail-closed to PAUSE is the correct behavior there).
- `npm run test:integration` — integration tier. Runs
  `test-decision.ts` with `INTEGRATION=1`, which makes the live Jev bridge
  cycle fail loudly instead of SKIP-logging. Requires a working `JEV_BIN`
  bridge (`./scripts/jev-bridge.py` with `TYPESAFE_API_KEY`, or any
  executable honoring the same `ask --state --questions --model` contract).

## Architecture

- `src/jupiter.ts` — Jupiter spot bid/ask feed. Cached, shared in-flight
  reads, fails soft to unknown/stale. Microscopic independently-routed quote
  crosses under 10 bps are tolerated (bid/ask normalized with min/max);
  larger inconsistencies are rejected.
- `src/dflow.ts` — DFlow spot feed via a Python `urllib` quote CLI
  (configurable with `DFLOW_QUOTE_BIN`) — never direct
  TypeScript fetch or curl for authenticated quotes. Same caching, freshness,
  and fail-soft semantics as Jupiter.
- `src/imperial.ts` — Imperial Phoenix-routed perps feed (mark, bid/ask,
  spread, funding rate, open interest). Read-only against Imperial's
  public API (`IMPERIAL_BASE_URL`). No orders ever pass through it.
- `src/coingecko.ts` + `src/regime.ts` — CoinGecko price context feeding the
  outer JEV regime gate. Cached 60s; data older than 300s pauses trading.
  Missing/stale data or JEV failure fails closed (paused).
- `src/decision.ts` — exactly one JEV request per cycle carrying an
  operation head plus speculative per-operation slippage-target heads; strict
  `validateChoice` (argmax, finite, keys == ids, sum ≈ 1, confidence in
  [0,1]); only the selected operation's target head is consumed; directional
  ops need confidence ≥ 0.9 or downgrade to HOLD; `PAUSE` honored immediately;
  any JEV failure or invalid answer → `PAUSE`, `jevOk: false`.
- `src/trader.ts` — the cycle: venue feeds → freshness gates → regime gate
  → `decideQuote` (one JEV request) → deterministic risk limits → simulated
  taker fills at the best executable price. Long-only spot, signed 1x perps,
  position caps, perps funding, realized/unrealized PnL. Cycles that arrive
  while the previous one is still in flight are emitted as `late` (no trade).
- `src/jev.ts` — TypeSafe/JEV access through the `JEV_BIN` bridge CLI
  (see "JEV access"). No API key is ever read into the Bun process —
  the key lives only in the bridge's environment. `MODEL=mock` selects the
  honest mock stand-in.
- `src/server.ts` — HTTP + SSE: `GET /` snapshot (meta + latest block),
  `GET /history` recent block events, `GET /regime` latest regime judgment,
  `GET /events` SSE stream (`snapshot`, `block`, `regime`, `fill`, `quote`,
  `ping`). Meta labels the wallet `dry-run (no wallet)`.

Fail-closed rules: JEV failure/invalid → `PAUSE`, `jevOk:false`; all venues
stale → `PAUSE`, reason `feeds-stale`; directional confidence < 0.9 → `HOLD`;
a side blocked by the regime gate or position cap shows as `executed:false`
with a deterministic reason (`spot-stale`, `perps-stale`, `side-blocked`,
`spread-exceeds-slippage`, `cap-full`, `no-inventory`).

## Deprecated: VENUE=phoenix

`VENUE=phoenix` no longer selects a runtime. It prints a deprecation warning
and starts the multi-venue mode anyway. The old Phoenix SOL-USDC spot
market-maker path is retired: the book on market
`4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg` is fossilized (3084 bps spread
at probe time, ~5% off independent prices) and the trader fails closed on it.
What remains of the Phoenix spot path: legacy probe/test scripts
(`scripts/probe-*.ts`, `scripts/test-trades.ts`) and `src/book.ts` /
`src/trades.ts` modules — read-only research tooling, not an executable
venue. Do not imply the fossilized book is quotable or executable.

## Verified (2026-09-25)

- All checks green: `test-decision`, `test-jupiter`, `test-dflow`,
  `test-imperial`, `test-trader` (24 checks), `test-coingecko-regime`,
  `test-trades`, `tsc --noEmit`, dashboard `next build`.
- Runtime dry-run verified end to end with `MODEL=mock` and `MODEL=jev`:
  cycles enter history; venue snapshots appear (Jupiter ~$117.46,
  DFlow ~$117.45, Imperial mark ~$117.55 vs CoinGecko ~$117.46, all within
  2%); SSE emits valid `snapshot`, `block`, `regime` events; `/history` and
  `/regime` respond; best-price venue fields appear on snapshots; Imperial
  funding/OI reach the JEV context; late-cycle overlap is emitted honestly.
- Live JEV in runtime: PAUSE/HOLD decisions at confidence 0.29–0.89, one JEV
  request per cycle, ~0.8–1.2s latency. No fills below 0.9 confidence —
  correct fail-closed behavior.
- No Solana RPC needed. No Phoenix spot interaction. No wallet access. No
  transaction construction, signing, submission, or live orders.

## Dashboard

`web/` — Next.js: Clawd lobster branding, Solana purple/green, slot feed,
operation decision panel (six operation probabilities, selected slippage,
deterministic route, simulated-fill status, rejection reasons), venue cards
(Jupiter/DFlow best bid/ask markers, Imperial mark/spread/funding/OI/
position/unrealized PnL), CoinGecko card, regime gate, dry-run/paused/
disconnected/no-data states. Footer: `powered by $CLAWD` · `Not advice.`

## Public dashboard + read-only API

Anyone can watch the live mock trader without running anything:

- **Dashboard:** https://musebook.trade/jev/ — operation decision, six
  operation probabilities, slippage target, Jupiter/DFlow/Imperial venue
  cards, regime gate, reference price, stats, and the live cycle feed.
  Banner: *Dry-run only — mock JEV, nothing is signed or submitted.*
- **Public API:** https://jev-api.musebook.trade/ — read-only:
  `GET /feed` (full snapshot), `GET /history`, `GET /regime`, `GET /`.
  CORS `*`, GET/OPTIONS only. No wallet, signing, execution, or trading
  endpoints exist anywhere on the public surface.

Data flow: the local trader (mock JEV, `DRY_RUN=true`) cycles every few
seconds; `jev-poller.py` POSTs a snapshot every ~30s to a secret-verified
ingest endpoint on the public worker, which caches the latest snapshot
(`status`, last 50 history entries, `regime`) for 1 hour. `watchdog.sh`
restarts the mock backend and the poller if either goes unhealthy.

`dns-stub.py` / `edge-relay.py` are leftover experiments from an abandoned
Cloudflare Tunnel approach — superseded by the poller architecture above.

## Honest status

- **Dry-run only.** Simulated fills at real quotes; no money moves, no
  signing, no live orders.
- **No production deployment** has been made or independently verified.
  Everything above describes local runs.
- `TRADE_SIZE_SOL`, `MAX_POSITION_SOL`, `PERP_SIZE_SOL`, `MAX_PERP_SOL`,
  and `BANKROLL_USD` are development scaffolding, not approved live terms.

## Companion repository & research paper

- **clawd-jev-trading-machine** — the JEV decision backend behind the same
  discipline: TypeSafe `jev-latest` brain, dynamic venue action space
  (Jupiter/DFlow admitted only on live quotes; out-of-set answers fail closed
  to `BLOCKED`), CoinGecko regime context, Supermemory recall, dry-run
  simulator, backtest replay.
  https://github.com/Solizardking/clawd-jev-trading-machine
- **Clawd Agentic Layer whitepaper (v0.3)** — the JEV decision-engine
  discipline proposed as an open standard for agentic trading: typed judgment
  primitive, dynamic action spaces, fail-closed execution, regime
  conditioning, episodic memory, simulation-before-action, six conformance
  invariants, and a machine-readable decision-record schema.
  PDF: https://musebook.trade/clawd-agentic-layer-whitepaper.pdf ·
  dataset: https://huggingface.co/datasets/ordlibrary/clawd-agentic-layer-whitepaper
