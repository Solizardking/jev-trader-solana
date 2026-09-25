/**
 * Direction judgments for SOL-USDC on Phoenix spot.
 *
 * The ONLY Jev path is src/jev.ts (the jev.py bridge via the user's connected
 * `custom.typesafe` connector). We never hold the raw TypeSafe API key — the
 * upstream model.ts used TYPESAFE_API_KEY; that pattern is NOT adopted here.
 *
 * Gate semantics (standing product rule), applied per side from the typed
 * probabilities:
 *   p >= 0.9  -> "approve"
 *   p <= 0.1  -> "block"
 *   otherwise -> "review" (surfaced, never auto-acted on)
 * A Jev failure never auto-approves: decide() throws JevError and the trader
 * must fail closed (no quote, paused state).
 */

import { config } from "./config";
import { askJev } from "./jev";

/** Models answer buy or sell. `hold` only appears on late slots (no decision was made). */
export type Action = "buy" | "sell" | "hold";

/** Per-side gate status derived from the typed probabilities. */
export type GateStatus = "approve" | "block" | "review";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: "SOL-USDC";
  venue: "phoenix-spot";
  slot: number;
  horizonSlots: number; // the question is about the move over this many slots
  slotMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  /** Cumulative resting SOL within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string; // oldest..newest, sampled every 5 slots over the horizon, space separated
  /** Taker prints over the last `horizonSlots`. cvdSol = taker buy volume - taker sell volume. */
  trades: { count: number; buySol: number; sellSol: number; cvdSol: number; vwap: number | null; lastPrice: number | null; lastSide: "buy" | "sell" | null };
  recentTrades: string[]; // newest last, "slot side size @ price"
  allowed: { buy: boolean; sell: boolean };
  /**
   * The Jev regime gate's read on this cycle (from src/regime.ts), or null
   * when it has not produced a judgment yet. The direction model sees the
   * regime as context; the trader ANDs `allowed` with its own risk gates.
   */
  regime: {
    choice: "bullish" | "bearish" | "chop" | "unknown";
    confidence: number;
    momentumYes: number | null;
    volatilityScore: number | null;
    allowedBuy: boolean;
    allowedSell: boolean;
    paused: boolean;
    reason: string;
  } | null;
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  gate: Record<"buy" | "sell", GateStatus>;
  upInHorizon: number;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<Decision>;
}

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will SOL be higher or lower than the current mid after `horizonSlots` more slots?",
      goal: "Trade SOL-USDC spot on Phoenix. Slots are ~400ms; `horizonSlots` (~30 s) is the horizon. A decision is made every slot and the quote is replaced each slot. The trade crosses the spread (`spreadBps`), so the move must beat that cost.",
      timing: "The order is a post-only limit quote resting on the book; it fills only if a taker crosses it.",
      inputs: "Taker flow is the strongest signal: `trades.cvdSol` (taker buys minus taker sells over the horizon), `trades.lastSide` and `recentTrades` show who is hitting the book. `depth` and `book` show resting liquidity per side at several distances from mid; thin depth on one side means price moves easily that way. `returnsBps` and `recentMids` show the path over the horizon. `regime` is a separate Jev judgment over CoinGecko + book features: a confidently bearish regime argues against buying, bullish against selling. If `allowed.buy` is false the quote will be a sell regardless, and vice versa.",
    },
    criteria: {
      buy: "Buy SOL now: mid more likely to be higher after `horizonSlots` slots, by more than the spread.",
      sell: "Sell SOL now: mid more likely to be lower after `horizonSlots` slots, by more than the spread.",
    },
  },
} as const;

/** Gate status from a single probability, per the standing product rule. */
export function gateStatus(p: number): GateStatus {
  if (p >= 0.9) return "approve";
  if (p <= 0.1) return "block";
  return "review";
}

/**
 * Real Jev via the jev.py bridge. Throws JevError on any failure —
 * the caller must fail closed (no quote, paused), never auto-approve.
 */
export class JevModel implements Model {
  readonly name = config.jevModelId;

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const { answers, latencyMs } = await askJev(JSON.stringify(state), QUESTIONS as any, {
      model: config.jevModelId,
      timeoutMs: config.jevTimeoutMs,
    });
    const a = answers.direction ?? {};
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = typeof p.buy === "number" ? p.buy : 0;
    const sell = typeof p.sell === "number" ? p.sell : 0;
    const choice = (a.choice === "buy" || a.choice === "sell") ? a.choice : buy >= sell ? "buy" : "sell";
    return {
      action: choice as Action,
      probabilities: { buy, sell, hold: 0 },
      gate: { buy: gateStatus(buy), sell: gateStatus(sell) },
      upInHorizon: buy,
      latencyMs: Math.round(latencyMs),
      inputTokens: 0, // the bridge does not report usage; cost is tracked per-call in the trader
    };
  }
}

/** Deterministic stand-in: momentum + imbalance + flow + noise, pulled toward flat. Honest name: "mock". */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const flow = state.trades.buySol + state.trades.sellSol
      ? state.trades.cvdSol / (state.trades.buySol + state.trades.sellSol)
      : 0;
    const regimeLean = !state.regime ? 0
      : state.regime.choice === "bullish" ? state.regime.confidence
      : state.regime.choice === "bearish" ? -state.regime.confidence : 0;
    const signal =
      state.returnsBps.last20 / 8 +
      state.bookImbalance * 1.5 +
      flow * 2 +
      regimeLean * 1.2 +
      this.noise(state.slot);
    const buy = 1 / (1 + Math.exp(-signal)); // binary softmax
    const probabilities = { buy, sell: 1 - buy, hold: 0 };
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    await Bun.sleep(80); // stand in for inference time so the pipeline behaves like production
    return {
      action,
      probabilities,
      gate: { buy: gateStatus(buy), sell: gateStatus(1 - buy) },
      upInHorizon: buy,
      latencyMs: Math.round(performance.now() - t0),
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  private noise(slot: number) {
    let h = (slot * 2654435761) >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

export const createModel = (): Model => (config.model === "jev" ? new JevModel() : new MockModel());
