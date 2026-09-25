/**
 * Dry-run verification for the CoinGecko + Jev regime integration.
 *   bun run scripts/test-coingecko-regime.ts
 * No wallet, no signing, no order submission — read-only checks.
 */
import { getCoingecko } from "../src/coingecko";
import { getRegimeGate, regimeEvent, buildRegimeState, _resetRegimeForTest } from "../src/regime";
import { _resetCoingeckoForTest } from "../src/coingecko";

const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

// 1. CoinGecko fetch: live, honest, never throws.
_resetCoingeckoForTest();
const snap = await getCoingecko();
console.log("snapshot:", JSON.stringify(snap, null, 2));
ok(snap.ok === true, "coingecko fetch succeeded");
ok(typeof snap.priceUsd === "number" && snap.priceUsd! > 0, "price is a positive number");
ok(snap.stale === false, "fresh snapshot not marked stale");
ok(snap.source === "coingecko", "source attribution present");

// 2. Cache sharing: second call is warm, no extra fetch.
const t0 = performance.now();
const snap2 = await getCoingecko();
ok(performance.now() - t0 < 50, "cached call is instant (shared, no refetch)");
ok(snap2.fetchedAt === snap.fetchedAt, "cache returns the same snapshot");

// 3. Regime gate with book features: Jev returns typed answers, gate responds.
_resetRegimeForTest();
const gate = await getRegimeGate({
  mid: snap.priceUsd ?? 0,
  spreadBps: 12,
  imbalance: 0.3,
  retBps20: 45,
  slot: 1,
});
console.log("gate:", JSON.stringify(regimeEvent(gate), null, 2));
ok(gate.jevOk === true, "jev answered (typed judgments)");
ok(["bullish", "bearish", "chop", "unknown"].includes(gate.regime.choice), "regime choice is typed");
ok(gate.momentumYes === null || (gate.momentumYes >= 0 && gate.momentumYes <= 1), "momentum is a probability");
ok(gate.volatility === null || (gate.volatility.score >= 0 && gate.volatility.score <= 3), "volatility score in 0..3");
ok(typeof gate.allowed.buy === "boolean" && typeof gate.allowed.sell === "boolean", "gate yields side permissions");

// 4. Gate TTL: second call reuses the cached judgment.
const t1 = performance.now();
const gate2 = await getRegimeGate();
ok(performance.now() - t1 < 50 && gate2.decidedAt === gate.decidedAt, "regime gate cached within TTL");

// 5. State string is inspectable JSON (what Jev judged).
console.log("state:", buildRegimeState(snap, { mid: snap.priceUsd ?? 0 }).slice(0, 300) + "…");

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
