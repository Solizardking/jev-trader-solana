/** API contract types — mirror src/trader.ts, src/regime.ts, src/coingecko.ts. */

export type Action = "buy" | "sell" | "hold";
export type Side = "buy" | "sell";
/** Per-side typed gate status from the direction Jev. */
export type GateStatus = "approve" | "block" | "review";

/** A simulated taker fill, expressed as a `sim` quote. `sent` until its receipt lands, then `placed` or `reverted`. */
export interface Quote {
  side: Side;
  price: number;
  size: number;
  txHash: string | null;
  feeSol: number;
  cancel: number[];
  status: "sent" | "placed" | "reverted" | "lost" | "sim";
  orderId: number | null;
  capped: boolean;
}

/** A simulated fill that landed this cycle. */
export interface Fill {
  side: Side;
  size: number;
  price: number;
  txHash: string | null;
  orderId: number | null;
  simulated: boolean;
}

/** Taker operations (one Jev request per cycle: operation head + slippage-target head). */
export type Operation = "BUY_SPOT" | "SELL_SPOT" | "LONG_PERP" | "SHORT_PERP" | "HOLD" | "PAUSE";

export interface Decision {
  /** Legacy 3-way projection of the operation head. */
  action: Action;
  /** Legacy normalized projection of the operation probabilities onto buy/sell/hold. */
  probabilities: { buy: number; sell: number; hold: number };
  gate: { buy: GateStatus; sell: GateStatus };
  /** No directional question is asked anymore; mirrors the regime's momentum read (0.5 when unknown). */
  upInHorizon: number;
  latencyMs: number;
  /** true when the cycle passed with no decision (or a failed one). */
  late: boolean;
  /** false when Jev failed; the trader fails closed (no trade). */
  jevOk: boolean;
  /** The chosen operation this cycle. */
  operation: Operation;
  /** Slippage tolerance (bps) Jev picked, or null when no trade was chosen. */
  slippageBps: number | null;
  /** Confidence of the selected operation (0.9+ to trade; below -> HOLD). */
  confidence: number;
  /** Confidence of the selected target head (null when no target selected). */
  targetConfidence: number | null;
  /** Probability distribution over the selected operation's slippage menu. */
  targetProbabilities: Record<string, number>;
  /** Probability distribution over the six operations. */
  operationProbabilities: Record<Operation, number>;
  /** Where the fill routed: spot = best-price venue (code-routed), perps = imperial. */
  venue: "jupiter" | "dflow" | "imperial" | null;
  /** "spot" | "perp" | null. */
  market: "spot" | "perp" | null;
  /** false when Jev chose a directional op but code did not fill (blocked by risk/spread/stale feed). */
  executed: boolean;
  /** Machine-readable reason. */
  reason: string;
}

export interface Position {
  side: "long" | "short" | "flat";
  size: number;
  entryPrice: number | null;
  unrealizedUsd: number;
  unrealizedSol: number;
}

export interface PerpPosition {
  side: "long" | "short" | "flat";
  size: number;
  entryPrice: number | null;
  unrealizedUsd: number;
  fundingPaidUsd: number;
  mark: number;
}

export interface VenueView {
  venue: "jupiter" | "dflow";
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  ok: boolean;
  ageMs: number;
  stale: boolean;
}

export interface PerpView {
  venue: "imperial";
  mark: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  fundingPerHourPct: number | null;
  openInterestUsd: number | null;
  ok: boolean;
  ageMs: number;
  stale: boolean;
}

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

export type RegimeChoice = "bullish" | "bearish" | "chop" | "unknown";

/** Regime gate snapshot embedded in a block event (flattened). */
export interface BlockRegime {
  choice: RegimeChoice;
  confidence: number;
  momentumYes: number | null;
  volatilityScore: number | null;
  allowedBuy: boolean;
  allowedSell: boolean;
  paused: boolean;
  reason: string;
  jevOk: boolean;
  jevLatencyMs: number | null;
}

export interface BlockEvent {
  /** Decision cycle number (timer-driven, not slot-driven). */
  slot: number;
  ts: number;
  /** Best cross-venue spot mid. */
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: Decision | null;
  quote: Quote | null;
  /** Every fill this cycle, expressed as `sim` quotes. */
  quotes: Quote[];
  fill: Fill | null;
  /** Taker mode keeps nothing resting. */
  resting: { bidSol: number; askSol: number };
  position: Position;
  /** 1x perps position (Imperial Phoenix-routed, simulated). */
  perp: PerpPosition | null;
  /** Per-venue snapshots behind this cycle. */
  venues: { jupiter: VenueView | null; dflow: VenueView | null; imperial: PerpView | null };
  regime: BlockRegime | null;
  totals: Totals;
}

export interface Meta {
  model: string;
  wallet: string | null;
  dryRun: boolean;
  market: string;
  /** Venue mode: "multi" = jupiter+dflow spot + imperial perps; "phoenix" = deprecated. */
  venue: string;
  startedAt: number;
}

export interface CoingeckoSnapshot {
  source: "coingecko";
  priceUsd: number | null;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  fetchedAt: number;
  ageMs: number;
  stale: boolean;
  ok: boolean;
}

/** Serialized RegimeGate — GET /regime and the SSE `regime` event. */
export interface RegimeEvent {
  type: "regime";
  decidedAt: number;
  paused: boolean;
  reason: string;
  allowed: { buy: boolean; sell: boolean };
  regime: { choice: RegimeChoice; confidence: number };
  momentumYes: number | null;
  volatility: { score: number; confidence: number } | null;
  jevOk: boolean;
  jevLatencyMs: number | null;
  coingecko: CoingeckoSnapshot;
}

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface FeedState {
  meta: Meta | null;
  events: BlockEvent[];
  latest: BlockEvent | null;
  /** Latest regime gate (from the `regime` SSE event or GET /regime), or null before the first one. */
  regime: RegimeEvent | null;
  connection: ConnectionState;
  avgLatencyMs: number;
}
