/**
 * Multi-venue taker trader (dry run): Jupiter + DFlow spot with deterministic
 * best-price routing, and 1x SOL perps on the Imperial Phoenix-routed book
 * (observe mode — this module never places orders, signs, or submits).
 *
 * Per-cycle flow: venue feeds -> freshness gates -> regime gate ->
 * decideQuote (ONE Jev request: operation + slippage target) ->
 * deterministic risk limits -> simulated fills at the best executable price.
 *
 * Decision architecture (ported from browser-use/jev-ultrafast): ONE Jev
 * request per cycle. The request carries an `operation` head plus speculative
 * per-operation slippage-target heads; only the selected operation's target
 * head is consumed. Jev chooses direction + venue/market + slippage
 * tolerance — never size. Size stays deterministic in code
 * (config.tradeSizeSol / config.perpSizeSol + position caps). Code controls
 * execution; Jev supplies typed judgments only.
 *
 * One decision in flight; a cycle that arrives while the previous one is
 * still running is emitted as late (hold, no trade).
 *
 * Dry run: fills are simulated immediately at the venue's executable
 * bid/ask proxy minus a small simulated fee. No wallet, no signing, no
 * submission, no live orders — on any venue, ever.
 *
 * Fail-closed rules:
 * - Jev failure or an invalid Jev answer => PAUSE, no trade (jevOk:false).
 * - Regime gate paused => no trade this cycle (reason surfaced).
 * - A directional op with operation confidence < 0.9 => downgraded to HOLD.
 * - PAUSE as the chosen operation is honored immediately (risk-off).
 * - Stale venue data blocks its market: no fresh spot quote => no spot
 *   trade; no fresh perps => no perp trade. Nothing stale/missing => PAUSE.
 * - A side forbidden by the regime gate or the position cap is not traded.
 * - A fill whose effective spread exceeds Jev's slippage tolerance is
 *   rejected (slippage-exceeded, no fill).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { config } from "./config";
import { type Action, type GateStatus } from "./model";
import {
  decideQuote, type AskFn, type DecisionStateInput, type Operation, type QuoteDecision, type VenueInput,
} from "./decision";
import { getJupiter, type JupiterSnapshot } from "./jupiter";
import { getDflow, type DflowSnapshot } from "./dflow";
import { getImperial, type ImperialSnapshot } from "./imperial";
import { getRegimeGate, regimeEvent, type RegimeGate } from "./regime";

/**
 * The decision payload in the snapshot and SSE. Legacy fields (action,
 * probabilities, gate, upInHorizon) are projections kept for the dashboard
 * contract; the new operation fields carry the actual taker decision.
 */
export interface DecisionEvent {
  /** Legacy projection: BUY_SPOT/LONG_PERP->buy, SELL_SPOT/SHORT_PERP->sell, HOLD/PAUSE->hold. */
  action: Action;
  /** Legacy projection of the operation-head probabilities onto buy/sell/hold (normalized). */
  probabilities: Record<Action, number>;
  /** Per-side permission this cycle: traded->approve, forbidden->block, else review. */
  gate: Record<"buy" | "sell", GateStatus>;
  /** No directional question is asked anymore; surfaces the regime's momentum read (0.5 when unknown). */
  upInHorizon: number;
  latencyMs: number;
  late: boolean;
  /** false when the judgment failed: failed closed, no trade. */
  jevOk: boolean;
  operation: Operation;
  /** Slippage tolerance (bps) Jev picked, or null when no trade was chosen. */
  slippageBps: number | null;
  confidence: number;
  targetConfidence: number | null;
  targetProbabilities: Record<string, number>;
  /** Probability distribution over the six operations (for the dashboard). */
  operationProbabilities: Record<Operation, number>;
  /** Where the fill routed: spot = best-price venue (code-routed), perps = imperial. null when no trade. */
  venue: "jupiter" | "dflow" | "imperial" | null;
  /** "spot" | "perp" | null. */
  market: "spot" | "perp" | null;
  /** false when Jev chose a directional op but code did not fill (blocked by risk/spread/stale feed). */
  executed: boolean;
  reason: string;
}

export interface VenueView {
  venue: "jupiter" | "dflow";
  bid: number; ask: number; mid: number; spreadBps: number;
  ok: boolean; ageMs: number; stale: boolean;
}

export interface PerpView {
  venue: "imperial";
  mark: number; bid: number; ask: number; mid: number; spreadBps: number;
  fundingPerHourPct: number | null;
  openInterestUsd: number | null;
  ok: boolean; ageMs: number; stale: boolean;
}

export interface PerpPosition {
  side: "long" | "short" | "flat";
  size: number;
  entryPrice: number | null;
  unrealizedUsd: number;
  fundingPaidUsd: number;
  mark: number;
}

export interface BlockEvent {
  /** Cycle number (the multi-venue loop is timer-driven, not slot-driven). */
  slot: number;
  ts: number;
  /** Best cross-venue spot mid (display + spot PnL mark). */
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: DecisionEvent | null;
  /** The simulated fill, expressed as a `sim` quote for dashboard contract parity. */
  quote: import("./market").Quote | null;
  quotes: import("./market").Quote[];
  /** The simulated fill that landed this cycle. */
  fill: import("./market").Fill | null;
  /** Taker mode keeps nothing resting. */
  resting: { bidSol: number; askSol: number };
  position: {
    side: "long" | "short" | "flat";
    size: number;
    entryPrice: number | null;
    unrealizedUsd: number;
    unrealizedSol: number;
  };
  /** 1x perps position (Imperial Phoenix-routed, simulated). */
  perp: PerpPosition | null;
  /** Per-venue snapshots behind this cycle. */
  venues: { jupiter: VenueView | null; dflow: VenueView | null; imperial: PerpView | null };
  /** The regime gate judgment behind this cycle, or null when unavailable. */
  regime: {
    choice: string;
    confidence: number;
    momentumYes: number | null;
    volatilityScore: number | null;
    allowedBuy: boolean;
    allowedSell: boolean;
    paused: boolean;
    reason: string;
    jevOk: boolean;
    jevLatencyMs: number | null;
  } | null;
  totals: Totals;
}

/** Per-cycle latency: the feed read, and read + decide + execute end to end. */
export interface Timing { readMs: number; loopMs: number }

export interface Totals {
  slots: number;
  decisions: number;
  quotes: number;
  fills: number;
  reverted: number;
  lateSlots: number;
  /** Cycles where every venue feed failed closed — no decision, no trade. */
  bookErrors: number;
  jevUsd: number;
  feeSol: number;
  feeUsd: number;
  /** Cumulative funding paid (positive) / received (negative) on the perps sim. */
  fundingUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlSol: number;
  pnlPct: number;
}

interface FillLike { side: "buy" | "sell"; size: number; price: number; txHash: string | null; orderId: number | null; simulated: boolean }

export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private lastGate: RegimeGate | null = null;
  private spot = { sol: 0, costUsd: 0 }; // signed spot inventory and cost basis (long-only: never short spot)
  private perp = { sol: 0, costUsd: 0, fundingPaidUsd: 0 }; // signed 1x perp inventory
  private lastCycleTs = 0;
  private totals: Totals = {
    slots: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateSlots: 0,
    bookErrors: 0,
    jevUsd: 0, feeSol: 0, feeUsd: 0, fundingUsd: 0,
    realizedUsd: 0, pnlUsd: 0, pnlSol: 0, pnlPct: 0,
  };

  constructor(
    private ask: AskFn,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (slot: number, fill: FillLike) => void = () => {},
    private onQuote: (slot: number, quote: import("./market").Quote) => void = () => {},
    private onRegime: (g: RegimeGate) => void = () => {},
    /**
     * Feed injection for tests. Defaults to the live venue modules and the
     * live regime gate. Tests pass stubs so routing/cap/funding rules run
     * deterministically and offline.
     */
    private feeds: {
      getJupiter: () => Promise<JupiterSnapshot>;
      getDflow: () => Promise<DflowSnapshot>;
      getImperial: () => Promise<ImperialSnapshot>;
      getRegime: (book: { mid?: number; spreadBps?: number; retBps20?: number; slot?: number }) => Promise<RegimeGate>;
    } = { getJupiter, getDflow, getImperial, getRegime: (book) => getRegimeGate(book) },
  ) {
    mkdirSync("data", { recursive: true });
  }

  /** The latest regime gate (for GET /regime). */
  get regime(): RegimeGate | null { return this.lastGate; }

  async onCycle(cycle: number) {
    this.totals.slots++;
    if (this.busy) {
      this.totals.lateSlots++;
      this.emitLate(cycle, "late-cycle");
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      // 1. Venue feeds, in parallel. Each is fail-soft: never throws.
      const [jup, dflow, imp] = await Promise.all([
        this.feeds.getJupiter(), this.feeds.getDflow(), this.feeds.getImperial(),
      ]);
      const readMs = performance.now() - t0;
      const venues = {
        jupiter: viewOf(jup),
        dflow: viewOf(dflow),
        imperial: perpViewOf(imp),
      };

      const jupFresh = fresh(jup, config.jupiterStaleMs);
      const dflowFresh = fresh(dflow, config.dflowStaleMs);
      const perpFresh = fresh(imp, config.imperialStaleMs);
      const spotFresh = jupFresh || dflowFresh;

      if (!spotFresh && !perpFresh) {
        // Fail closed, not silent: no venue data at all — no decision, no trade.
        this.totals.bookErrors++;
        console.error(`cycle ${cycle}: all venue feeds failed closed (jupiter+dflow+imperial stale/unknown)`);
        this.emitLate(cycle, "feeds-stale", venues, "PAUSE", false);
        return;
      }

      // 2. Deterministic best-price routing (code, never Jev): best bid across
      //    fresh spot venues, best ask across fresh spot venues.
      const best = bestSpot(jup, dflow, jupFresh, dflowFresh);
      if (best) {
        this.mids.push(best.mid);
        if (this.mids.length > 400) this.mids.shift();
      }
      const mid = best?.mid ?? this.mids.at(-1) ?? imp.mid ?? 0;

      // 3. Live funding accrual on the open perp position (1x, signed by side).
      this.accrueFunding(imp);

      // 4. Regime gate: one cached Jev judgment per decision cycle (cheap when warm).
      const gate = await this.regimeFor(best, cycle);
      if (gate.paused) {
        this.emitCodeHold(cycle, venues, mid, gate, "PAUSE", gate.reason, readMs, t0);
        return;
      }

      // 5. ONE Jev request per cycle: operation + slippage target.
      const input = this.decisionInput(cycle, jup, dflow, imp, best, gate);
      let qd: QuoteDecision | null = null;
      try {
        qd = await decideQuote(input, { ask: this.ask });
      } catch (e) {
        // decideQuote fails closed internally; this is a last-resort guard.
        console.error(`cycle ${cycle}: decideQuote threw:`, (e as Error).message);
        qd = null;
      }
      this.totals.decisions++;
      if (qd) this.totals.jevUsd += (qd.inputTokens / 1e6) * config.jevUsdPerMTok;

      // 6. Deterministic risk limits + simulated execution.
      const outcome = qd?.jevOk
        ? this.execute(qd, gate, best, imp, jupFresh, dflowFresh, perpFresh)
        : { exec: null, blockReason: null };
      const { exec, blockReason } = outcome;
      const decision = qd ? this.decisionEvent(qd, gate, exec, blockReason) : null;
      if (exec?.fill) {
        this.onFill(cycle, exec.fill);
        if (exec.quote) this.onQuote(cycle, exec.quote);
      }
      this.emit(cycle, venues, mid, best, imp, decision, exec, gate, readMs, t0);
    } catch (e) {
      console.error(`cycle ${cycle}:`, (e as Error).message);
    } finally {
      this.busy = false;
      this.lastCycleTs = Date.now();
    }
  }

  /** Latest regime judgment, refreshed per cycle (cached inside getRegimeGate). */
  private async regimeFor(best: { mid: number; spreadBps: number } | null, cycle: number): Promise<RegimeGate> {
    const gate = await this.feeds.getRegime({
      mid: best?.mid,
      spreadBps: best?.spreadBps,
      retBps20: this.ret(20),
      slot: cycle,
    });
    if (gate.decidedAt !== this.lastGate?.decidedAt) {
      this.lastGate = gate;
      this.onRegime(gate);
    }
    return gate;
  }

  /** Funding: longs pay shorts when the rate is positive; reversed when negative. 1x notional. */
  private accrueFunding(imp: ImperialSnapshot) {
    if (this.perp.sol === 0 || imp.fundingPerHourPct == null || imp.mark == null || this.lastCycleTs === 0) return;
    const dtH = (Date.now() - this.lastCycleTs) / 3_600_000;
    if (dtH <= 0 || dtH > 1) return; // sanity: ignore clock jumps
    const notional = Math.abs(this.perp.sol) * imp.mark;
    const payment = notional * (imp.fundingPerHourPct / 100) * dtH;
    // payment > 0 means longs pay: a long's cost rises, a short's falls.
    this.perp.fundingPaidUsd += Math.sign(this.perp.sol) * payment;
    this.totals.fundingUsd = this.perp.fundingPaidUsd;
  }

  /**
   * Deterministic risk limits + simulated fills. Jev chose the operation and
   * slippage tolerance; everything else — side permission, position caps,
   * spread-vs-tolerance, venue, price, fees — is code.
   */
  private execute(
    qd: QuoteDecision,
    gate: RegimeGate,
    best: { bid: number; ask: number; spreadBps: number; bidVenue: "jupiter" | "dflow"; askVenue: "jupiter" | "dflow" } | null,
    imp: ImperialSnapshot,
    jupFresh: boolean, dflowFresh: boolean, perpFresh: boolean,
  ): {
    exec: { quote: import("./market").Quote; fill: FillLike; venue: "jupiter" | "dflow" | "imperial"; market: "spot" | "perp" } | null;
    /** Machine-readable reason when a directional choice was blocked by code (null when not blocked). */
    blockReason: string | null;
  } {
    const op = qd.operation;
    const blocked = (blockReason: string) => ({ exec: null, blockReason });
    if (op === "HOLD" || op === "PAUSE") return { exec: null, blockReason: null };
    const tol = qd.slippageBps ?? 0;

    if (op === "BUY_SPOT" || op === "SELL_SPOT") {
      if (!best) return blocked("spot-stale");
      if (op === "BUY_SPOT" && !gate.allowed.buy) return blocked("side-blocked");
      if (op === "SELL_SPOT" && !gate.allowed.sell) return blocked("side-blocked");
      if (best.spreadBps > tol) return blocked("spread-exceeds-slippage"); // slippage-exceeded: the spread can't hold this tolerance
      let size = config.tradeSizeSol;
      if (op === "BUY_SPOT") {
        size = Math.min(size, config.maxPositionSol - this.spot.sol);
      } else {
        size = Math.min(size, this.spot.sol); // spot is long-only: never short spot
      }
      if (!(size > 1e-6)) return blocked(op === "BUY_SPOT" ? "cap-full" : "no-inventory");
      const venue = op === "BUY_SPOT" ? best.askVenue : best.bidVenue;
      const price = op === "BUY_SPOT" ? best.ask : best.bid;
      const side = op === "BUY_SPOT" ? "buy" : "sell";
      const feeUsd = size * price * (config.spotFeeBps / 10_000);
      this.totals.feeUsd += feeUsd;
      this.applyFill(this.spot, side, size, price);
      this.totals.quotes++;
      this.totals.fills++;
      return {
        exec: {
          venue, market: "spot",
          quote: { side, price, size, txHash: null, feeSol: 0, cancel: [], status: "sim", orderId: null, capped: size < config.tradeSizeSol },
          fill: { side, size, price, txHash: null, orderId: null, simulated: true },
        },
        blockReason: null,
      };
    }

    // Perps: 1x only, no leverage. Fills at the Imperial Phoenix top of book.
    if (!perpFresh || imp.bid == null || imp.ask == null || imp.mid == null) return blocked("perps-stale");
    if (op === "LONG_PERP" && !gate.allowed.buy) return blocked("side-blocked");
    if (op === "SHORT_PERP" && !gate.allowed.sell) return blocked("side-blocked");
    if (imp.spreadBps != null && imp.spreadBps > tol) return blocked("spread-exceeds-slippage"); // slippage-exceeded
    let size = config.perpSizeSol;
    if (op === "LONG_PERP") size = Math.min(size, config.maxPerpSol - this.perp.sol);
    else size = Math.min(size, config.maxPerpSol + this.perp.sol); // perp.sol negative when short
    if (!(size > 1e-6)) return blocked("cap-full");
    const price = op === "LONG_PERP" ? imp.ask : imp.bid;
    const side = op === "LONG_PERP" ? "buy" : "sell";
    const feeUsd = size * price * (config.perpFeeBps / 10_000);
    this.totals.feeUsd += feeUsd;
    this.applyFill(this.perp, side, size, price);
    this.totals.quotes++;
    this.totals.fills++;
    return {
      exec: {
        venue: "imperial", market: "perp",
        quote: { side, price, size, txHash: null, feeSol: 0, cancel: [], status: "sim", orderId: null, capped: size < config.perpSizeSol },
        fill: { side, size, price, txHash: null, orderId: null, simulated: true },
      },
      blockReason: null,
    };
  }

  /** Signed-inventory fill accounting (spot and perps share the math). */
  private applyFill(pos: { sol: number; costUsd: number }, side: "buy" | "sell", size: number, price: number) {
    if (size <= 0) return;
    const signed = side === "buy" ? size : -size;
    if (pos.sol === 0 || Math.sign(pos.sol) === Math.sign(signed)) {
      pos.costUsd += signed * price; // adding to position
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(pos.sol)) * Math.sign(signed);
      const entry = pos.costUsd / pos.sol;
      this.totals.realizedUsd += -closing * (price - entry); // closing part realizes pnl
      pos.costUsd += closing * entry;
      const remainder = signed - closing;
      pos.costUsd += remainder * price; // any flip opens the other way
    }
    pos.sol += signed;
    if (Math.abs(pos.sol) < 1e-9) { pos.sol = 0; pos.costUsd = 0; }
  }

  private spotEntry() { return this.spot.sol ? this.spot.costUsd / this.spot.sol : null; }
  private perpEntry() { return this.perp.sol ? this.perp.costUsd / this.perp.sol : null; }
  private spotUnrealized(mid: number) { return this.spot.sol ? this.spot.sol * (mid - this.spotEntry()!) : 0; }
  private perpUnrealized(mark: number) { return this.perp.sol ? this.perp.sol * (mark - this.perpEntry()!) : 0; }

  private ret(k: number) {
    const m = this.mids, n = m.length;
    return n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0;
  }

  /** Structured decision input: numbers/facts only. Market data is untrusted input, never instructions. */
  private decisionInput(
    cycle: number,
    jup: JupiterSnapshot, dflow: DflowSnapshot, imp: ImperialSnapshot,
    best: { bid: number; ask: number; mid: number; spreadBps: number; bidVenue: string; askVenue: string } | null,
    gate: RegimeGate,
  ): DecisionStateInput {
    const m = this.mids;
    const sampled = m.slice(-75).filter((_, i, a) => (a.length - 1 - i) % 5 === 0);
    const vn = (s: { bid: number | null; ask: number | null; mid: number | null; spreadBps: number | null; ageMs: number; ok: boolean }): VenueInput => ({
      bid: s.bid, ask: s.ask, mid: s.mid, spreadBps: s.spreadBps,
      ageSec: s.ok ? Math.round(s.ageMs / 1000) : null, ok: s.ok,
    });
    const spotMark = best?.mid ?? this.mids.at(-1) ?? null;
    return {
      spot: {
        jupiter: vn(jup),
        dflow: vn(dflow),
        bestBid: best?.bid ?? null, bestAsk: best?.ask ?? null,
        bestMid: best?.mid ?? null, bestSpreadBps: best?.spreadBps ?? null,
        bestBidVenue: best?.bidVenue ?? null, bestAskVenue: best?.askVenue ?? null,
        refPriceUsd: jup.refPriceUsd,
      },
      perps: {
        mark: imp.mark, bid: imp.bid, ask: imp.ask, mid: imp.mid, spreadBps: imp.spreadBps,
        fundingPerHourPct: imp.fundingPerHourPct,
        openInterestUsd: imp.openInterestUsd,
        basis: imp.mark != null && spotMark != null ? imp.mark - spotMark : null,
        ageSec: imp.ok ? Math.round(imp.ageMs / 1000) : null, ok: imp.ok,
      },
      position: {
        spotSol: this.spot.sol,
        spotEntry: this.spotEntry(),
        spotUnrealizedUsd: this.spotUnrealized(spotMark ?? 0),
        perpSol: this.perp.sol,
        perpEntry: this.perpEntry(),
        perpUnrealizedUsd: this.perpUnrealized(imp.mark ?? 0),
        perpFundingPaidUsd: this.perp.fundingPaidUsd,
        maxPositionSol: config.maxPositionSol,
        maxPerpSol: config.maxPerpSol,
      },
      risk: {
        tradeSizeSol: config.tradeSizeSol,
        perpSizeSol: config.perpSizeSol,
        maxPositionSol: config.maxPositionSol,
        maxPerpSol: config.maxPerpSol,
        allowedSpotBuy: gate.allowed.buy,
        allowedSpotSell: gate.allowed.sell,
        allowedPerpLong: gate.allowed.buy,
        allowedPerpShort: gate.allowed.sell,
      },
      regime: {
        choice: gate.regime.choice,
        confidence: gate.regime.confidence,
        momentumYes: gate.momentumYes,
        volatilityScore: gate.volatility?.score ?? null,
        allowedBuy: gate.allowed.buy,
        allowedSell: gate.allowed.sell,
        paused: gate.paused,
        reason: gate.reason,
      },
      recent: { retBps20: this.ret(20), mids: sampled },
    };
  }

  /**
   * Map a QuoteDecision onto the DecisionEvent contract. The legacy
   * buy/sell/hold fields are projections of the operation head (documented
   * on DecisionEvent); the operation/venue/market fields carry the real decision.
   */
  private decisionEvent(
    qd: QuoteDecision,
    gate: RegimeGate,
    exec: { venue: "jupiter" | "dflow" | "imperial"; market: "spot" | "perp" } | null,
    blockReason: string | null,
  ): DecisionEvent {
    const p = qd.probabilities;
    const buy = (p.BUY_SPOT ?? 0) + (p.LONG_PERP ?? 0);
    const sell = (p.SELL_SPOT ?? 0) + (p.SHORT_PERP ?? 0);
    const hold = (p.HOLD ?? 0) + (p.PAUSE ?? 0);
    const total = buy + sell + hold || 1;
    const action: Action =
      qd.operation === "BUY_SPOT" || qd.operation === "LONG_PERP" ? "buy"
      : qd.operation === "SELL_SPOT" || qd.operation === "SHORT_PERP" ? "sell"
      : "hold";
    const isSpotDir = qd.operation === "BUY_SPOT" || qd.operation === "SELL_SPOT";
    const isPerpDir = qd.operation === "LONG_PERP" || qd.operation === "SHORT_PERP";
    const dirSide = qd.operation === "BUY_SPOT" || qd.operation === "LONG_PERP" ? "buy" : "sell";
    const gateFor = (side: "buy" | "sell"): GateStatus => {
      if (exec && ((side === "buy" && dirSide === "buy") || (side === "sell" && dirSide === "sell"))) return "approve";
      const allowed = side === "buy" ? gate.allowed.buy : gate.allowed.sell;
      return allowed ? "review" : "block";
    };
    return {
      action,
      probabilities: { buy: buy / total, sell: sell / total, hold: hold / total },
      gate: { buy: gateFor("buy"), sell: gateFor("sell") },
      upInHorizon: gate.momentumYes ?? 0.5,
      latencyMs: Math.round(qd.latencyMs),
      late: false,
      jevOk: qd.jevOk,
      operation: qd.operation,
      slippageBps: qd.slippageBps,
      confidence: qd.confidence,
      targetConfidence: qd.targetConfidence,
      targetProbabilities: qd.targetProbabilities,
      operationProbabilities: qd.probabilities,
      venue: exec?.venue ?? null,
      market: exec?.market ?? (isSpotDir ? "spot" : isPerpDir ? "perp" : null),
      executed: exec !== null,
      // A code block overrides the judgment reason so the event says why
      // nothing filled; a filled or unblocked decision keeps Jev's reason.
      reason: blockReason ?? qd.reason,
    };
  }

  /** Code hold without a Jev decision (regime paused, late cycle, or feeds stale). */
  private codeHoldDecision(operation: "HOLD" | "PAUSE", reason: string, jevOk = true): DecisionEvent {
    return {
      action: "hold",
      probabilities: { buy: 0, sell: 0, hold: 1 },
      gate: { buy: "review", sell: "review" },
      upInHorizon: 0.5, latencyMs: 0, late: false, jevOk,
      operation, slippageBps: null, confidence: 0,
      targetConfidence: null, targetProbabilities: {},
      operationProbabilities: {} as Record<Operation, number>,
      venue: null, market: null, executed: false,
      reason,
    };
  }

  private emitLate(
    cycle: number, reason: string,
    venues: BlockEvent["venues"] = { jupiter: null, dflow: null, imperial: null },
    /** feeds-stale is risk-off: PAUSE with jevOk false; a busy-cycle skip is a plain HOLD. */
    operation: "HOLD" | "PAUSE" = "HOLD", jevOk = true,
  ) {
    const mid = this.mids.at(-1) ?? 0;
    const gate = this.lastGate;
    this.emit(cycle, venues, mid, null, null, this.codeHoldDecision(operation, reason, jevOk), null, gate, 0, performance.now(), true);
  }

  private emitCodeHold(
    cycle: number,
    venues: BlockEvent["venues"], mid: number, gate: RegimeGate,
    operation: "HOLD" | "PAUSE", reason: string, readMs: number, t0: number,
  ) {
    this.emit(cycle, venues, mid, null, null, this.codeHoldDecision(operation, reason), null, gate, readMs, t0);
  }

  private emit(
    cycle: number,
    venues: BlockEvent["venues"],
    mid: number,
    best: { bid: number; ask: number; spreadBps: number } | null,
    imp: ImperialSnapshot | null,
    decision: DecisionEvent | null,
    exec: { quote: import("./market").Quote; fill: FillLike } | null,
    gate: RegimeGate | null,
    readMs: number,
    t0: number,
    late = false,
  ) {
    const t = this.totals;
    const spotU = this.spotUnrealized(mid);
    const mark = imp?.mark ?? mid;
    const perpU = this.perpUnrealized(mark);
    t.pnlUsd = t.realizedUsd + spotU + perpU - t.feeUsd - t.fundingUsd;
    t.pnlSol = mid > 0 ? t.pnlUsd / mid : 0;
    t.pnlPct = (t.pnlUsd / config.bankrollUsd) * 100;
    const spotSize = Math.abs(this.spot.sol);
    const perpSize = Math.abs(this.perp.sol);
    const event: BlockEvent = {
      slot: cycle, ts: Date.now(),
      mid: round(mid, 3),
      bestBid: best ? round(best.bid, 3) : 0,
      bestAsk: best ? round(best.ask, 3) : 0,
      spreadBps: best ? round(best.spreadBps, 2) : 0,
      decision: late && decision ? { ...decision, late: true } : decision,
      quote: exec?.quote ?? null,
      quotes: exec?.quote ? [exec.quote] : [],
      fill: exec?.fill ?? null,
      resting: { bidSol: 0, askSol: 0 }, // taker mode: nothing rests
      position: {
        side: this.spot.sol > 0 ? "long" : "flat",
        size: round(spotSize, 4),
        entryPrice: this.spotEntry(),
        unrealizedUsd: round(spotU, 4),
        unrealizedSol: mid > 0 ? round(spotU / mid, 4) : 0,
      },
      perp: {
        side: this.perp.sol > 0 ? "long" : this.perp.sol < 0 ? "short" : "flat",
        size: round(perpSize, 4),
        entryPrice: this.perpEntry(),
        unrealizedUsd: round(perpU, 4),
        fundingPaidUsd: round(this.perp.fundingPaidUsd, 6),
        mark: round(mark, 3),
      },
      venues,
      regime: gate && {
        choice: gate.regime.choice,
        confidence: round(gate.regime.confidence, 3),
        momentumYes: gate.momentumYes,
        volatilityScore: gate.volatility?.score ?? null,
        allowedBuy: gate.allowed.buy,
        allowedSell: gate.allowed.sell,
        paused: gate.paused,
        reason: gate.reason,
        jevOk: gate.jevOk,
        jevLatencyMs: gate.jevLatencyMs,
      },
      totals: {
        ...t, jevUsd: round(t.jevUsd, 6), feeSol: round(t.feeSol, 6), feeUsd: round(t.feeUsd, 6),
        fundingUsd: round(t.fundingUsd, 6),
        realizedUsd: round(t.realizedUsd, 4), pnlUsd: round(t.pnlUsd, 4),
        pnlSol: round(t.pnlSol, 4), pnlPct: round(t.pnlPct, 3),
      },
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    appendFileSync("data/events.jsonl", JSON.stringify(event) + "\n");
    this.onEvent(event, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) });
  }
}

function fresh(s: { ok: boolean; ageMs: number }, staleMs: number): boolean {
  return s.ok && s.ageMs <= staleMs;
}

function viewOf(s: JupiterSnapshot | DflowSnapshot): VenueView | null {
  if (!s.ok || s.bid == null || s.ask == null || s.mid == null || s.spreadBps == null) return null;
  return {
    venue: s.source, bid: s.bid, ask: s.ask, mid: s.mid, spreadBps: s.spreadBps,
    ok: s.ok, ageMs: Math.round(s.ageMs), stale: s.stale,
  };
}

function perpViewOf(s: ImperialSnapshot): PerpView | null {
  if (!s.ok || s.mark == null || s.bid == null || s.ask == null || s.mid == null || s.spreadBps == null) return null;
  return {
    venue: "imperial",
    mark: s.mark, bid: s.bid, ask: s.ask, mid: s.mid, spreadBps: s.spreadBps,
    fundingPerHourPct: s.fundingPerHourPct, openInterestUsd: s.openInterestUsd,
    ok: s.ok, ageMs: Math.round(s.ageMs), stale: s.stale,
  };
}

/**
 * Deterministic best-price routing across fresh spot venues:
 * best (highest) bid, best (lowest) ask — each tagged with its venue.
 */
function bestSpot(
  jup: JupiterSnapshot, dflow: DflowSnapshot, jupFresh: boolean, dflowFresh: boolean,
): { bid: number; ask: number; mid: number; spreadBps: number; bidVenue: "jupiter" | "dflow"; askVenue: "jupiter" | "dflow" } | null {
  const bids: Array<{ v: "jupiter" | "dflow"; p: number }> = [];
  const asks: Array<{ v: "jupiter" | "dflow"; p: number }> = [];
  if (jupFresh && jup.bid != null) bids.push({ v: "jupiter", p: jup.bid });
  if (dflowFresh && dflow.bid != null) bids.push({ v: "dflow", p: dflow.bid });
  if (jupFresh && jup.ask != null) asks.push({ v: "jupiter", p: jup.ask });
  if (dflowFresh && dflow.ask != null) asks.push({ v: "dflow", p: dflow.ask });
  if (!bids.length || !asks.length) return null;
  const bestBid = bids.reduce((a, b) => (b.p > a.p ? b : a));
  const bestAsk = asks.reduce((a, b) => (b.p < a.p ? b : a));
  if (!(bestBid.p > 0 && bestAsk.p > 0 && bestBid.p <= bestAsk.p)) return null;
  const mid = (bestBid.p + bestAsk.p) / 2;
  return {
    bid: bestBid.p, ask: bestAsk.p, mid,
    spreadBps: ((bestAsk.p - bestBid.p) / mid) * 10_000,
    bidVenue: bestBid.v, askVenue: bestAsk.v,
  };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export { regimeEvent };
