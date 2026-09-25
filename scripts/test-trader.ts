/**
 * Trader routing + accounting rules, fully stubbed (no network, no live Jev).
 *   bun run scripts/test-trader.ts
 * Covers:
 *   - deterministic best bid/ask spot routing (jupiter vs dflow)
 *   - spot stale while perps fresh -> spot trades blocked, perp trades allowed
 *   - perps stale while spot fresh -> perp trades blocked, spot trades allowed
 *   - all venues stale -> PAUSE, jevOk false, nothing fills
 *   - slippage tolerance rejection -> spread-exceeds-slippage, nothing fills
 *   - 1x perps cap at MAX_PERP_SOL, realized PnL on partial close
 *   - funding accrual sign (long pays when funding positive; short receives)
 *   - unrealized PnL mark-to-market
 * The ask function is a scripted stand-in returning valid bridge-shaped answers,
 * NOT a live Jev call. Defaults: TRADE_SIZE_SOL=0.1, MAX_POSITION_SOL=1,
 * PERP_SIZE_SOL=0.1, MAX_PERP_SOL=0.5.
 */
import { Trader } from "../src/trader";

const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

const NOW = Date.now();
const fresh = (extra: Record<string, unknown>) => ({
  fetchedAt: NOW, ageMs: 0, stale: false, ok: true, ...extra,
});

const jupSnap = (bid: number, ask: number, stale = false) => fresh({
  source: "jupiter", bid, ask, mid: (bid + ask) / 2,
  spreadBps: ((ask - bid) / ((bid + ask) / 2)) * 10_000,
  refPriceUsd: 100, fetchedAt: stale ? NOW - 301_000 : NOW, ageMs: stale ? 301_000 : 0, stale, ok: !stale,
});
const dflowSnap = (bid: number, ask: number, stale = false) => fresh({
  source: "dflow", bid, ask, mid: (bid + ask) / 2,
  spreadBps: ((ask - bid) / ((bid + ask) / 2)) * 10_000,
  fetchedAt: stale ? NOW - 301_000 : NOW, ageMs: stale ? 301_000 : 0, stale, ok: !stale,
});
const impSnap = (mark: number, funding: number | null = 0, stale = false) => fresh({
  source: "imperial", mark, bid: mark - 0.01, ask: mark + 0.01, mid: mark,
  spreadBps: (0.02 / mark) * 10_000, fundingPerHourPct: funding, openInterestUsd: 1e6,
  fetchedAt: stale ? NOW - 301_000 : NOW, ageMs: stale ? 301_000 : 0, stale, ok: !stale,
});

const stubRegime = async () => ({
  paused: false, reason: "ok",
  allowed: { buy: true, sell: true },
  regime: { choice: "chop" as const, confidence: 0.5 },
  momentumYes: 0.5, volatility: null, jevOk: true, jevLatencyMs: 0,
  coingecko: null as any, decidedAt: Date.now(),
});

function stubFeeds(overrides: { jup?: any; dflow?: any; imp?: any } = {}) {
  return {
    getJupiter: async () => overrides.jup ?? jupSnap(99.9, 100.1),
    getDflow: async () => overrides.dflow ?? dflowSnap(99.9, 100.05),
    getImperial: async () => overrides.imp ?? impSnap(100, 0),
    getRegime: stubRegime,
  };
}

const OPS = ["BUY_SPOT", "SELL_SPOT", "LONG_PERP", "SHORT_PERP", "HOLD", "PAUSE"] as const;
const SIDS = ["s10", "s25", "s50"] as const;
const sIdFor = (bps: number) => (bps <= 10 ? "s10" : bps <= 25 ? "s25" : "s50");
const targetKeyFor = (op: string) => op.toLowerCase() + "_target";

/** Scripted stand-in returning valid bridge-shaped answers (not a live Jev call). */
function scriptedAsk(op: (typeof OPS)[number], opts: { slippageBps?: number; confidence?: number; targetConfidence?: number } = {}) {
  const confidence = opts.confidence ?? 0.95;
  const sId = sIdFor(opts.slippageBps ?? 25);
  const tConf = opts.targetConfidence ?? 0.8;
  const opProbs: Record<string, number> = {};
  for (const o of OPS) opProbs[o] = o === op ? 1 : 0;
  const answers: Record<string, unknown> = {
    operation: { choice: op, confidence, probabilities: opProbs },
  };
  for (const o of OPS.slice(0, 4)) {
    const probs: Record<string, number> = {};
    for (const s of SIDS) probs[s] = s === sId ? 1 : 0;
    answers[targetKeyFor(o)] = { choice: sId, confidence: tConf, probabilities: probs };
  }
  return async (_state: unknown, _q: unknown, _o?: unknown) => ({ answers, latencyMs: 1 });
}

function makeTrader(
  op: (typeof OPS)[number],
  overrides: { jup?: any; dflow?: any; imp?: any } = {},
  opts: { slippageBps?: number; confidence?: number; targetConfidence?: number } = {},
) {
  const seen: any[] = [];
  const t = new Trader(
    scriptedAsk(op, opts) as any,
    (e) => { seen.push(e); },
    () => {}, () => {}, () => {},
    stubFeeds(overrides),
  );
  return { t, seen, setOp: (o: (typeof OPS)[number], o2: typeof opts = {}) => {
    (t as any).ask = scriptedAsk(o, { ...opts, ...o2 }) as any;
  } };
}

// Tight quotes (~15-20 bps) so s25 tolerates them; dflow ask is lowest.
const TIGHT = { jup: jupSnap(99.9, 100.1), dflow: dflowSnap(99.9, 100.05) };

// ---------- 1. best-price spot routing ----------
// BUY_SPOT: jupiter ask 100.1 vs dflow ask 100.05 -> dflow wins (lowest ask).
{
  const { t, seen } = makeTrader("BUY_SPOT", TIGHT);
  await t.onCycle(1);
  const d = seen[0].decision;
  ok(d.operation === "BUY_SPOT" && d.executed && d.venue === "dflow",
    `BUY_SPOT routes to lowest ask (dflow 100.05 vs jup 100.1) -> got ${d.venue}`);
  ok(seen[0].fill && seen[0].fill.price === 100.05, `fill at dflow ask 100.05 (got ${seen[0].fill?.price})`);
}

// SELL_SPOT: bids tie at 99.9 (jupiter wins ties) -> fill at 99.9.
{
  const buyer = makeTrader("BUY_SPOT", TIGHT);
  await buyer.t.onCycle(1); // long 0.1 SOL @ 100.05
  buyer.setOp("SELL_SPOT");
  await buyer.t.onCycle(2);
  const d = buyer.seen[1].decision;
  ok(d.executed && d.venue === "jupiter", `SELL_SPOT routes to highest bid -> got ${d.venue}`);
  ok(buyer.seen[1].fill.price === 99.9, `fill at jupiter bid 99.9 (got ${buyer.seen[1].fill.price})`);
  ok(buyer.seen[1].position.size === 0, `spot position flat after round trip (got ${buyer.seen[1].position.size})`);
}

// ---------- 2. spot stale, perps fresh ----------
// BUY_SPOT must not fill (reason spot-stale); the judgment is recorded, executed=false.
{
  const { t, seen } = makeTrader("BUY_SPOT", {
    jup: jupSnap(99.9, 100.1, true), dflow: dflowSnap(99.9, 100.05, true), imp: impSnap(100, 0),
  });
  await t.onCycle(1);
  const d = seen[0].decision;
  ok(d.operation === "BUY_SPOT" && !d.executed && d.venue === null && d.reason === "spot-stale",
    `spot-stale BUY_SPOT -> blocked with reason (${d.reason})`);
  ok(seen[0].fill === null, "no fill when spot feeds stale");
}

// LONG_PERP with spot stale but perps fresh: still allowed.
{
  const { t, seen } = makeTrader("LONG_PERP", {
    jup: jupSnap(99.9, 100.1, true), dflow: dflowSnap(99.9, 100.05, true), imp: impSnap(100, 0),
  });
  await t.onCycle(1);
  const d = seen[0].decision;
  ok(d.executed && d.venue === "imperial" && d.market === "perp", `perps-fresh LONG_PERP executes (${d.reason})`);
  ok(seen[0].perp.side === "long" && seen[0].perp.size === 0.1, `perp position long 0.1 SOL (got ${seen[0].perp.side} ${seen[0].perp.size})`);
}

// ---------- 3. perps stale, spot fresh -> LONG_PERP blocked, BUY_SPOT fine ----------
{
  const { t, seen } = makeTrader("LONG_PERP", { ...TIGHT, imp: impSnap(100, 0, true) });
  await t.onCycle(1);
  const d = seen[0].decision;
  ok(!d.executed && d.reason === "perps-stale", `perps-stale LONG_PERP -> blocked (${d.reason})`);
}
{
  const { t, seen } = makeTrader("BUY_SPOT", { ...TIGHT, imp: impSnap(100, 0, true) });
  await t.onCycle(1);
  ok(seen[0].decision.executed, "perps-stale BUY_SPOT still executes");
}

// ---------- 4. all venues stale -> PAUSE, jevOk false, nothing fills ----------
{
  const { t, seen } = makeTrader("BUY_SPOT", {
    jup: jupSnap(99.9, 100.1, true), dflow: dflowSnap(99.9, 100.05, true), imp: impSnap(100, 0, true),
  });
  await t.onCycle(1);
  const d = seen[0].decision;
  ok(d.operation === "PAUSE" && d.jevOk === false && d.reason === "feeds-stale" && !d.executed && seen[0].fill === null,
    `all-stale -> PAUSE, jevOk false (${d.reason})`);
}

// ---------- 5. slippage tolerance rejection ----------
// s10 = 10 bps; spot spread ~40 bps -> rejected.
{
  const { t, seen } = makeTrader("BUY_SPOT", {
    jup: jupSnap(99.8, 100.2), dflow: dflowSnap(99.8, 100.2),
  }, { slippageBps: 10 });
  await t.onCycle(1);
  const d = seen[0].decision;
  ok(!d.executed && d.reason === "spread-exceeds-slippage",
    `40 bps spread vs 10 bps tolerance -> no fill (${d.reason})`);
}

// ---------- 6. perps cap at MAX_PERP_SOL (0.5) ----------
// Five LONG_PERP cycles reach the 0.5 cap; the sixth is blocked with cap-full.
{
  const mk = makeTrader("LONG_PERP", TIGHT);
  for (let i = 1; i <= 5; i++) await mk.t.onCycle(i);
  ok(mk.seen[4].perp.size === 0.5, `five 0.1 lots reach the 0.5 cap (got ${mk.seen[4].perp.size})`);
  await mk.t.onCycle(6);
  const d = mk.seen[5].decision;
  ok(!d.executed && d.reason === "cap-full", `sixth long at cap -> blocked (${d.reason})`);
  ok(mk.seen[5].perp.size === 0.5, "position stays at cap");
}

// ---------- 7. realized PnL on partial close ----------
// Long 0.3 @ 100 (mark 100 -> ask 100.01 fill), then SHORT_PERP @ 101 closes 0.1 -> realized +~0.1.
{
  const mk = makeTrader("LONG_PERP", { ...TIGHT, imp: impSnap(100, 0) });
  await mk.t.onCycle(1);
  await mk.t.onCycle(2);
  await mk.t.onCycle(3);
  ok(mk.seen[2].perp.size === 0.3, `long 0.3 after three lots (got ${mk.seen[2].perp.size})`);
  (mk.t as any).feeds = stubFeeds({ ...TIGHT, imp: impSnap(101, 0) });
  mk.setOp("SHORT_PERP");
  await mk.t.onCycle(4);
  const p = mk.seen[3].perp;
  ok(p.side === "long" && Math.abs(p.size - 0.2) < 1e-9, `partial close leaves long 0.2 (got ${p.side} ${p.size})`);
  const realized = mk.seen[3].totals.realizedUsd;
  ok(realized > 0, `realized PnL positive on profitable partial close (got ${realized.toFixed(4)})`);
}

// ---------- 8. funding accrual sign ----------
// Positive funding: long pays (fundingUsd > 0), short receives (fundingUsd < 0).
{
  const funding = 0.0024; // %/h
  const mk = makeTrader("LONG_PERP", { ...TIGHT, imp: impSnap(100, funding) });
  await mk.t.onCycle(1); // opens; lastCycleTs set
  mk.setOp("HOLD");
  (mk.t as any).lastCycleTs = Date.now() - 30_000; // pretend 30s passed since the last cycle
  await mk.t.onCycle(2); // accrues
  ok(mk.seen[1].totals.fundingUsd > 0, `long pays funding when rate positive (fundingUsd=${mk.seen[1].totals.fundingUsd.toFixed(8)})`);
}
{
  const funding = 0.0024;
  const mk = makeTrader("SHORT_PERP", { ...TIGHT, imp: impSnap(100, funding) });
  await mk.t.onCycle(1);
  mk.setOp("HOLD");
  (mk.t as any).lastCycleTs = Date.now() - 30_000; // pretend 30s passed since the last cycle
  await mk.t.onCycle(2);
  ok(mk.seen[1].totals.fundingUsd < 0, `short receives funding when rate positive (fundingUsd=${mk.seen[1].totals.fundingUsd.toFixed(8)})`);
}

// ---------- 9. unrealized PnL mark-to-market ----------
// Long 0.1 @ 100.01 (ask), mark moves to 101 -> unrealized = 0.1 * 0.99 = 0.099.
{
  const mk = makeTrader("LONG_PERP", { ...TIGHT, imp: impSnap(100, 0) });
  await mk.t.onCycle(1);
  (mk.t as any).feeds = stubFeeds({ ...TIGHT, imp: impSnap(101, 0) });
  mk.setOp("HOLD");
  await mk.t.onCycle(2);
  const u = mk.seen[1].perp.unrealizedUsd;
  ok(Math.abs(u - 0.099) < 1e-6, `unrealized marks long 0.1 up 0.99 -> +0.099 (got ${u})`);
}

// ---------- 10. ask throw -> PAUSE, jevOk false ----------
{
  const seen: any[] = [];
  const t = new Trader(
    (async () => { throw new Error("bridge down"); }) as any,
    (e) => { seen.push(e); },
    () => {}, () => {}, () => {},
    stubFeeds(),
  );
  await t.onCycle(1);
  const d = seen[0].decision;
  ok(d.operation === "PAUSE" && d.jevOk === false && !d.executed, "ask throw -> PAUSE, jevOk false");
}

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
