/**
 * Regime gate: narrow typed Jev judgments over { CoinGecko market snapshot +
 * Phoenix book features }, composed into risk gates the trader loop can act on.
 *
 * Questions (asked together, over the same state):
 *   regime     — choice {bullish, bearish, chop}: the current market regime
 *   momentum   — noul:  P(the current directional move continues ~30s out)
 *   volatility — score: ordered 0..3 calm → extreme
 *
 * Product gate semantics (standing rule):
 *   approve  when all relevant checks are >= 0.9
 *   block    when any check is <= 0.1
 *   review   otherwise (surface, don't auto-act)
 *   Jev failure never auto-approves → the gate fails closed (paused).
 *
 * Cadence: Jev answers are cached for REGIME_TTL_MS (default 15s); one call in
 * flight is shared. The trader should call getRegimeGate() per decision cycle
 * — it is cheap when warm.
 */

import { config } from "./config";
import { getCoingecko, type CoingeckoSnapshot } from "./coingecko";
import { askJev, JevError } from "./jev";

/** Book features the trader already computes. All optional — absence is marked in state. */
export interface BookFeatures {
  mid?: number;
  spreadBps?: number;
  imbalance?: number; // -1..1 within 1% of mid
  retBps20?: number;  // mid return over ~20 slots, in bps
  slot?: number;
}

export type RegimeChoice = "bullish" | "bearish" | "chop" | "unknown";

export interface RegimeGate {
  /** true => the trader must not quote this cycle. */
  paused: boolean;
  /** Short reason code, e.g. "coingecko-stale", "jev-unavailable", "regime-bearish". */
  reason: string;
  /** Side-level permissions from the regime judgment. */
  allowed: { buy: boolean; sell: boolean };
  regime: { choice: RegimeChoice; confidence: number };
  /** P(upward move continues). null when Jev failed. */
  momentumYes: number | null;
  volatility: { score: number; confidence: number } | null;
  /** false => Jev failed; the gate is fail-closed (paused). */
  jevOk: boolean;
  jevLatencyMs: number | null;
  coingecko: CoingeckoSnapshot;
  decidedAt: number;
}

const REGIME_QUESTIONS = {
  regime: {
    type: "choice",
    instructions: {
      question: "What regime best describes SOL right now?",
      context: "Spot SOL-USDC on Solana. The trader posts short-horizon limit quotes on Phoenix and needs to know whether the tape is directionally safe.",
      inputs: "`coingecko.change24hPct` and `coingecko.priceUsd` vs `high24h`/`low24h` show the day's drift and where price sits in its range. `book.imbalance` (-1 all asks .. 1 all bids) and `book.retBps20` show the last few seconds of book pressure and mid movement. Agreeing signals = trend; disagreeing or flat signals = chop.",
    },
    criteria: {
      bullish: "Upward regime: 24h change positive and price near the day's high, and/or book bids dominate with positive recent returns.",
      bearish: "Downward regime: 24h change negative and price near the day's low, and/or book asks dominate with negative recent returns.",
      chop: "No clear direction: flat or mixed 24h change, price mid-range, balanced book, or conflicting signals.",
    },
  },
  momentum: {
    type: "noul",
    instructions: {
      question: "Will SOL's current directional move continue over roughly the next 30 seconds?",
      note: "Answer yes with high probability only if the drift is consistent across the 24h CoinGecko move and the last-seconds book pressure. Flat or conflicting state should sit near 0.5.",
    },
  },
  volatility: {
    type: "score",
    instructions: {
      question: "How volatile is SOL right now?",
      note: "Judge from the 24h range (high/low vs price), the 24h % move, and the book spread/imbalance swings.",
    },
    criteria: [
      "Calm: 24h range under ~3%, small 24h move, tight book spread, no sharp recent returns.",
      "Normal: 24h range ~3-8% or a moderate one-day move with an orderly book.",
      "Elevated: 24h range ~8-15%, or a strong one-day move, or the book spread/pressure swinging.",
      "Extreme: 24h range above ~15%, fast moves, very wide or unstable book — unsafe to quote blind.",
    ],
  },
} as const;

/** Build the state string Jev judges. Compact, named, human-readable. */
export function buildRegimeState(snap: CoingeckoSnapshot, book: BookFeatures): string {
  const cg = {
    priceUsd: snap.priceUsd, change24hPct: snap.change24hPct,
    high24h: snap.high24h, low24h: snap.low24h,
    volume24hUsd: snap.volume24hUsd, marketCapUsd: snap.marketCapUsd,
    dataAgeSec: snap.ok ? Math.round(snap.ageMs / 1000) : null,
    dataOk: snap.ok,
  };
  const bk = {
    mid: book.mid ?? null,
    spreadBps: book.spreadBps ?? null,
    imbalance: book.imbalance ?? null,
    retBps20: book.retBps20 ?? null,
    slot: book.slot ?? null,
    available: book.mid != null,
  };
  return JSON.stringify({ market: "SOL-USDC", venue: "phoenix-spot", coingecko: cg, book: bk });
}

function emptyGate(snap: CoingeckoSnapshot, reason: string, jevOk: boolean): RegimeGate {
  return {
    paused: true, reason,
    allowed: { buy: false, sell: false },
    regime: { choice: "unknown", confidence: 0 },
    momentumYes: null, volatility: null,
    jevOk, jevLatencyMs: null,
    coingecko: snap, decidedAt: Date.now(),
  };
}

async function decide(snap: CoingeckoSnapshot, book: BookFeatures): Promise<RegimeGate> {
  // Gate 1: market-data freshness. No trustworthy reference price => no quoting.
  if (!snap.ok || snap.ageMs > config.coingeckoStaleMs) {
    return emptyGate(snap, !snap.ok ? "coingecko-unavailable" : "coingecko-stale", true);
  }

  let answers: Record<string, any>;
  let latencyMs: number;
  try {
    const r = await askJev(buildRegimeState(snap, book), REGIME_QUESTIONS as any);
    answers = r.answers;
    latencyMs = r.latencyMs;
  } catch (e) {
    // Jev failure never auto-approves: fail closed.
    if (!(e instanceof JevError)) console.error("[regime] unexpected:", (e as Error).message);
    else console.error("[regime] jev failed:", e.message);
    return emptyGate(snap, "jev-unavailable", false);
  }

  const regimeRaw = answers.regime ?? {};
  const choice = (["bullish", "bearish", "chop"] as const).includes(regimeRaw.choice)
    ? (regimeRaw.choice as RegimeChoice) : "unknown";
  const confidence = typeof regimeRaw.confidence === "number" ? regimeRaw.confidence : 0;
  const momentumYes = typeof answers.momentum?.noul === "number" ? answers.momentum.noul : null;
  const vol = answers.volatility ?? {};
  const volatility = typeof vol.score === "number"
    ? { score: vol.score, confidence: typeof vol.confidence === "number" ? vol.confidence : 0 }
    : null;

  const gate: RegimeGate = {
    paused: false, reason: "ok",
    allowed: { buy: true, sell: true },
    regime: { choice, confidence },
    momentumYes, volatility,
    jevOk: true, jevLatencyMs: Math.round(latencyMs),
    coingecko: snap, decidedAt: Date.now(),
  };

  // Gate 2: extreme volatility => pause everything.
  if (volatility && volatility.score >= config.volPauseScore) {
    gate.paused = true;
    gate.reason = "volatility-extreme";
    gate.allowed = { buy: false, sell: false };
    return gate;
  }

  // Gate 3: confidently adverse regime blocks the leaning side.
  // Product semantics: block when a check is <= 0.1 against that side.
  if (choice === "bearish" && confidence >= 0.9) {
    gate.allowed.buy = false;
    gate.reason = "regime-bearish";
  } else if (choice === "bullish" && confidence >= 0.9) {
    gate.allowed.sell = false;
    gate.reason = "regime-bullish";
  } else {
    gate.reason = "review"; // neither confident nor failed: surface, don't auto-act
  }
  return gate;
}

// --- cached entry point: one in-flight Jev call shared by all consumers ---
let cached: RegimeGate | null = null;
let inflight: Promise<RegimeGate> | null = null;

export async function getRegimeGate(book: BookFeatures = {}): Promise<RegimeGate> {
  const now = Date.now();
  if (cached && now - cached.decidedAt < config.regimeTtlMs) return cached;
  if (!inflight) {
    inflight = (async () => {
      const snap = await getCoingecko();
      return decide(snap, book);
    })().finally(() => { inflight = null; });
  }
  cached = await inflight;
  return cached;
}

/** Test-only: reset module state. */
export function _resetRegimeForTest() {
  cached = null;
  inflight = null;
}

/**
 * JSON payload for the trader snapshot and the SSE `regime` event.
 * Shape is stable; the future server.ts can broadcast it as-is.
 */
export function regimeEvent(g: RegimeGate) {
  const c = g.coingecko;
  return {
    type: "regime",
    decidedAt: g.decidedAt,
    paused: g.paused,
    reason: g.reason,
    allowed: g.allowed,
    regime: g.regime,
    momentumYes: g.momentumYes,
    volatility: g.volatility,
    jevOk: g.jevOk,
    jevLatencyMs: g.jevLatencyMs,
    coingecko: {
      source: c.source, priceUsd: c.priceUsd, change24hPct: c.change24hPct,
      high24h: c.high24h, low24h: c.low24h,
      volume24hUsd: c.volume24hUsd, marketCapUsd: c.marketCapUsd,
      fetchedAt: c.fetchedAt, ageMs: Math.round(c.ageMs), stale: c.stale, ok: c.ok,
    },
  };
}
