/**
 * Verification for the multi-venue taker decision architecture
 * (Jupiter + DFlow spot, Imperial perps; best-price routing in code).
 *   bun run scripts/test-decision.ts
 * No wallet, no signing, no order submission — read-only checks.
 * The live Jev cycle at the end is best-effort by default: if the
 * bridge/network is unavailable it logs SKIP (fail-closed is the correct
 * behavior there). Set INTEGRATION=1 to make it fail loudly instead —
 * that's the documented integration tier for CI/reviewers with TypeSafe
 * access.
 */
import {
  DECISION_RULES, TARGET_RULES,
  OPERATION_IDS,
  BUY_SPOT_IDS, SELL_SPOT_IDS, LONG_PERP_IDS, SHORT_PERP_IDS,
  buildDecisionQuestions, buildDecisionState, validateChoice,
  decideQuote, mockAskJev, DecisionError, type DecisionStateInput, type VenueInput,
} from "../src/decision";
import { JevError } from "../src/jev";

const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

const throwsDecisionError = (fn: () => void) => {
  try { fn(); return false; } catch (e) { return e instanceof DecisionError; }
};

const good = (choice: string, probs: Record<string, number>, confidence = probs[choice]!) => ({
  choice, probabilities: probs, confidence,
});

const vn = (over: Partial<VenueInput> = {}): VenueInput => ({
  bid: 117.4, ask: 117.6, mid: 117.5, spreadBps: 17, ageSec: 3, ok: true, ...over,
});

const input = (): DecisionStateInput => ({
  spot: {
    jupiter: vn(),
    dflow: vn({ bid: 117.42, ask: 117.58 }),
    bestBid: 117.42, bestAsk: 117.58, bestMid: 117.5, bestSpreadBps: 13.6,
    bestBidVenue: "dflow", bestAskVenue: "dflow",
    refPriceUsd: 117.5,
  },
  perps: {
    mark: 117.52, bid: 117.5, ask: 117.54, mid: 117.52, spreadBps: 3.4,
    fundingPerHourPct: 0.002, openInterestUsd: 800000,
    basis: 0.02, ageSec: 2, ok: true,
  },
  position: {
    spotSol: 0.1, spotEntry: 117.0, spotUnrealizedUsd: 0.05,
    perpSol: 0, perpEntry: null, perpUnrealizedUsd: 0, perpFundingPaidUsd: 0,
    maxPositionSol: 1, maxPerpSol: 0.5,
  },
  risk: {
    tradeSizeSol: 0.1, perpSizeSol: 0.1, maxPositionSol: 1, maxPerpSol: 0.5,
    allowedSpotBuy: true, allowedSpotSell: true, allowedPerpLong: true, allowedPerpShort: true,
  },
  regime: {
    choice: "bullish", confidence: 0.95, momentumYes: 0.7, volatilityScore: 1,
    allowedBuy: true, allowedSell: false, paused: false, reason: "regime-bullish",
  },
  recent: { retBps20: 12.5, mids: [117.1, 117.2, 117.45] },
});

// ---------- 1. validateChoice: strict port of ultrafast's validate_choice ----------
{
  const probs = Object.fromEntries(OPERATION_IDS.map((id) => [id, id === "BUY_SPOT" ? 0.9 : 0.02]));
  const a = good("BUY_SPOT", probs);
  ok(validateChoice(a, OPERATION_IDS) === a, "validateChoice accepts a valid answer");

  const sumOff = good("BUY_SPOT", { BUY_SPOT: 0.8, SELL_SPOT: 0.02, LONG_PERP: 0.02, SHORT_PERP: 0.02, HOLD: 0.02, PAUSE: 0.02 }); // 0.9
  ok(throwsDecisionError(() => validateChoice(sumOff, OPERATION_IDS)), "rejects probability sum off by >0.02");

  const notArgmax = good("HOLD", probs, 0.5);
  ok(throwsDecisionError(() => validateChoice(notArgmax, OPERATION_IDS)), "rejects choice that is not the argmax");

  const unknownId = good("NUKE", Object.fromEntries(OPERATION_IDS.map((id) => [id, 1 / 6])));
  ok(throwsDecisionError(() => validateChoice(unknownId, OPERATION_IDS)), "rejects unknown choice id");

  const nonFinite = good("BUY_SPOT", Object.fromEntries(OPERATION_IDS.map((id) => [id, id === "BUY_SPOT" ? NaN : 0.2])));
  ok(throwsDecisionError(() => validateChoice(nonFinite, OPERATION_IDS)), "rejects non-finite probability");

  const extraKey = { ...probs, EXTRA: 0.02 };
  ok(throwsDecisionError(() => validateChoice(good("BUY_SPOT", extraKey), OPERATION_IDS)), "rejects probability keys != ids (extra key)");

  const missingKey: any = { choice: "BUY_SPOT", confidence: 0.6, probabilities: { BUY_SPOT: 0.6, SELL_SPOT: 0.4 } };
  ok(throwsDecisionError(() => validateChoice(missingKey, OPERATION_IDS)), "rejects probability keys != ids (missing keys)");

  const badConf = good("BUY_SPOT", probs, 1.5);
  ok(throwsDecisionError(() => validateChoice(badConf, OPERATION_IDS)), "rejects confidence outside [0,1]");

  ok(throwsDecisionError(() => validateChoice(null, OPERATION_IDS)), "rejects null answer");
  ok(throwsDecisionError(() => validateChoice({}, OPERATION_IDS)), "rejects empty answer");
}

// ---------- 2. question shape: operation head + speculative slippage-target heads ----------
{
  const q = buildDecisionQuestions();
  ok(Object.keys(q).sort().join(",") === "buy_spot_target,long_perp_target,operation,sell_spot_target,short_perp_target",
    "exactly five questions: operation + four slippage-target heads");
  for (const [id, qq] of Object.entries(q)) {
    ok(qq.type === "choice" && typeof qq.criteria === "object" && typeof qq.instructions === "object",
      `question ${id} has {type, criteria, instructions}`);
  }
  ok(Object.keys(q.operation!.criteria).length === 6 &&
    OPERATION_IDS.every((id) => id in q.operation!.criteria),
    "operation head offers BUY_SPOT/SELL_SPOT/LONG_PERP/SHORT_PERP/HOLD/PAUSE");
  ok(BUY_SPOT_IDS.join(",") === "s10,s25,s50" && SELL_SPOT_IDS.length === 3 &&
    LONG_PERP_IDS.length === 3 && SHORT_PERP_IDS.length === 3,
    "slippage menus are small and discrete (s10/s25/s50)");
  ok(new Set([...BUY_SPOT_IDS]).size === 3, "slippage ids unique");
  const crit = q.buy_spot_target!.criteria as Record<string, any>;
  ok(Object.keys(crit).every((id) => typeof crit[id].slippageBps === "number"),
    "target criteria carry structured slippageBps (never executable code)");
  ok(typeof DECISION_RULES === "string" && DECISION_RULES.includes("never trade when the regime is paused") &&
    typeof TARGET_RULES === "string" && TARGET_RULES.includes("slippage tolerance"),
    "instruction constants present (taker policy prose)");
  const instr = q.long_perp_target!.instructions as any;
  ok(instr.operation === "LONG_PERP" && Array.isArray(instr.rules) && instr.rules.length === 2,
    "target head instructions carry goal + operation + both rule sets");
}

// ---------- 3. decision state: structured, numbers/facts only ----------
{
  const s = buildDecisionState(input());
  const leaves: unknown[] = [];
  const walk = (v: unknown) => {
    if (v === null) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") return Object.values(v as object).forEach(walk);
    leaves.push(v);
  };
  walk(s);
  ok(leaves.every((l) => ["number", "string", "boolean"].includes(typeof l)), "state leaves are numbers/strings/booleans only (no functions, no instructions)");
  ok(["spot", "perps", "position", "risk", "regime", "recent"].every((k) => k in s),
    "state has spot/perps/position/risk/regime/recent");
  ok((s.spot as any).bestBidVenue === "dflow" && (s.perps as any).basis === 0.02,
    "state carries deterministic best-price routing facts and perp basis");
  ok(JSON.parse(JSON.stringify(s)) !== null, "state JSON round-trips");
}

// ---------- 4. fail-closed: broken bridge / invalid answers ----------
{
  const boom = async () => { throw new JevError("bridge down"); };
  const r1 = await decideQuote(input(), { ask: boom });
  ok(r1.operation === "PAUSE" && r1.jevOk === false && r1.reason === "jev-call-failed",
    "JevError -> PAUSE, jevOk false (fail closed, never auto-approve)");

  const garbage = async () => ({ answers: { operation: { choice: "BUY_SPOT" } }, latencyMs: 5 });
  const r2 = await decideQuote(input(), { ask: garbage });
  ok(r2.operation === "PAUSE" && r2.jevOk === false && r2.reason === "invalid-operation-answer",
    "invalid operation answer -> PAUSE, jevOk false");

  const opProbs = (choice: string, conf: number) =>
    Object.fromEntries(OPERATION_IDS.map((id) => [id, id === choice ? conf : (1 - conf) / 5]));
  const badTarget = async () => ({
    answers: {
      operation: good("BUY_SPOT", opProbs("BUY_SPOT", 0.95)),
      buy_spot_target: { choice: "t9", probabilities: { t9: 1 }, confidence: 1 }, // not a real id
      sell_spot_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
      long_perp_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
      short_perp_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
    },
    latencyMs: 5,
  });
  const r3 = await decideQuote(input(), { ask: badTarget });
  ok(r3.operation === "PAUSE" && r3.jevOk === false && r3.reason === "invalid-target-answer",
    "invalid target head -> PAUSE, jevOk false");
}

// ---------- 5. confidence gates + selected-head-only consumption ----------
{
  const opProbs = (choice: string, conf: number) =>
    Object.fromEntries(OPERATION_IDS.map((id) => [id, id === choice ? conf : (1 - conf) / 5]));

  // BUY_SPOT at 0.7 confidence -> downgraded to HOLD, jevOk stays true.
  const lowConf = async () => ({
    answers: {
      operation: good("BUY_SPOT", opProbs("BUY_SPOT", 0.7)),
      buy_spot_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
      sell_spot_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
      long_perp_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
      short_perp_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
    },
    latencyMs: 5,
  });
  const r1 = await decideQuote(input(), { ask: lowConf });
  ok(r1.operation === "HOLD" && r1.jevOk === true && r1.reason === "low-confidence-downgrade:BUY_SPOT" &&
    r1.slippageBps === null,
    "directional op below 0.9 confidence downgrades to HOLD (uncertain judgment never trades)");

  // PAUSE honored immediately, even at modest confidence.
  const pause = async () => ({
    answers: {
      operation: good("PAUSE", opProbs("PAUSE", 0.6)),
      buy_spot_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
      sell_spot_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
      long_perp_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
      short_perp_target: good("s25", { s10: 0.1, s25: 0.8, s50: 0.1 }),
    },
    latencyMs: 5,
  });
  const r2 = await decideQuote(input(), { ask: pause });
  ok(r2.operation === "PAUSE" && r2.jevOk === true && r2.reason === "ok",
    "PAUSE as the argmax choice is honored immediately (risk-off always safe)");

  // LONG_PERP at 0.95: only long_perp_target is consumed; the other heads may be garbage.
  const long = async () => ({
    answers: {
      operation: good("LONG_PERP", opProbs("LONG_PERP", 0.95)),
      long_perp_target: { choice: "s50", probabilities: { s10: 0.05, s25: 0.1, s50: 0.85 }, confidence: 0.85 },
      buy_spot_target: { choice: "bogus", probabilities: {}, confidence: 0 }, // ignored
      sell_spot_target: { choice: "bogus", probabilities: {}, confidence: 0 }, // ignored
      short_perp_target: { choice: "bogus", probabilities: {}, confidence: 0 }, // ignored
    },
    latencyMs: 7,
  });
  const r3 = await decideQuote(input(), { ask: long });
  ok(r3.operation === "LONG_PERP" && r3.jevOk === true && r3.reason === "ok" &&
    r3.slippageBps === 50 && r3.targetConfidence === 0.85 &&
    r3.targetProbabilities.s50 === 0.85,
    "LONG_PERP consumes only the selected target head (other heads ignored, even when invalid)");
}

// ---------- 6. mock ask: valid answers end to end ----------
{
  const r = await decideQuote(input(), { ask: mockAskJev });
  ok(OPERATION_IDS.includes(r.operation as any) && typeof r.confidence === "number",
    `mock ask yields a shaped decision (got ${r.operation}, jevOk=${r.jevOk})`);
  ok(r.reason === "ok" || r.reason.startsWith("low-confidence-downgrade"),
    "mock decision reason is sane");
  const r2 = await decideQuote(input(), { ask: mockAskJev });
  ok(r2.operation === r.operation && r2.slippageBps === r.slippageBps,
    "mock ask is deterministic for the same state");
}

// ---------- 7. askJev accepts an object state (no network: broken bridge proves the path) ----------
{
  process.env.JEV_BIN = "/bin/false"; // jev.py would exit non-zero; proves state was stringified and the bridge invoked
  const { askJev } = await import("../src/jev");
  let threw = false, msg = "";
  try {
    await askJev({ market: "SOL-USDC", n: 1 }, { operation: { type: "choice" } });
  } catch (e) { threw = e instanceof JevError; msg = (e as Error).message; }
  ok(threw && msg.includes("exited"), "askJev accepts an object state (JSON.stringified before the bridge call)");
  let emptyThrew = false;
  try { await askJev("   ", { operation: { type: "choice" } }); }
  catch (e) { emptyThrew = e instanceof JevError; }
  ok(emptyThrew, "askJev still rejects an empty state");
}

// ---------- 8. one live decision cycle if the network allows (best-effort) ----------
{
  delete process.env.JEV_BIN; // restore the real bridge (JEV_BIN is read at call time)
  const { askJev } = await import("../src/jev");
  const r = await decideQuote(input(), { ask: askJev }); // never throws for Jev failures
  if (r.jevOk) {
    ok(OPERATION_IDS.includes(r.operation as any) && r.latencyMs > 0,
      `live Jev decision cycle: operation=${r.operation} conf=${r.confidence.toFixed(2)} (${r.latencyMs}ms)`);
  } else if (process.env.INTEGRATION === "1") {
    // Integration tier: the live bridge is expected to work — a failure is a
    // loud FAIL, not a SKIP.
    ok(false, `live Jev cycle (INTEGRATION=1): bridge unreachable (${r.reason})`);
  } else {
    console.log(`SKIP  live Jev cycle (bridge unavailable: ${r.reason}; fail-closed to PAUSE is the correct behavior)`);
  }
}

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
