"use client";

import type { BlockEvent, BlockRegime, GateStatus, Operation, RegimeEvent } from "@/lib/types";
import { fmtPct } from "@/lib/format";
import styles from "./DecisionPanel.module.css";

export interface DecisionPanelProps {
  latest: BlockEvent | null;
  /** Live gate event (preferred) — the slot-embedded regime is the fallback. */
  regime: RegimeEvent | null;
}

const OPERATIONS: Operation[] = ["BUY_SPOT", "SELL_SPOT", "LONG_PERP", "SHORT_PERP", "HOLD", "PAUSE"];
const OP_SHORT: Record<Operation, string> = {
  BUY_SPOT: "BUY SPOT",
  SELL_SPOT: "SELL SPOT",
  LONG_PERP: "LONG PERP",
  SHORT_PERP: "SHORT PERP",
  HOLD: "HOLD",
  PAUSE: "PAUSE",
};

interface BarRowProps {
  label: string;
  /** css color for the label text */
  labelColor: string;
  /** dims the label to .38 when false */
  active: boolean;
  /** 0..1, fill width as a fraction of the track */
  value: number;
  /** css background for the fill */
  fill: string;
  /** right-hand percentage text ("62%" or "-") */
  pct: string;
}

function BarRow({ label, labelColor, active, value, fill, pct }: BarRowProps) {
  return (
    <div className={styles.row}>
      <span
        className={styles.label}
        style={{ color: labelColor, opacity: active ? 1 : 0.38 }}
      >
        {label}
      </span>
      <div className={styles.track}>
        <div
          className={styles.fill}
          style={{
            width: `${Math.max(0, Math.min(1, value)) * 100}%`,
            background: fill,
          }}
        />
      </div>
      <span className={styles.pct}>{pct}</span>
    </div>
  );
}

const GATE_CLASS: Record<GateStatus, string> = {
  approve: styles.gateApprove,
  block: styles.gateBlock,
  review: styles.gateReview,
};

function GateChip({ side, status }: { side: string; status: GateStatus }) {
  return (
    <span className={`${styles.gateChip} ${GATE_CLASS[status]}`} title={`Jev typed gate: ${status}`}>
      {side} · {status}
    </span>
  );
}

interface GateView {
  choice: string;
  confidence: number;
  allowedBuy: boolean;
  allowedSell: boolean;
  paused: boolean;
  reason: string;
  momentumYes: number | null;
  volatilityScore: number | null;
  jevOk: boolean;
  source: "live" | "slot";
}

function gateOf(regime: RegimeEvent | null, slotRegime: BlockRegime | null): GateView | null {
  if (regime) {
    return {
      choice: regime.regime.choice,
      confidence: regime.regime.confidence,
      allowedBuy: regime.allowed.buy,
      allowedSell: regime.allowed.sell,
      paused: regime.paused,
      reason: regime.reason,
      momentumYes: regime.momentumYes,
      volatilityScore: regime.volatility?.score ?? null,
      jevOk: regime.jevOk,
      source: "live",
    };
  }
  if (slotRegime) {
    return {
      choice: slotRegime.choice,
      confidence: slotRegime.confidence,
      allowedBuy: slotRegime.allowedBuy,
      allowedSell: slotRegime.allowedSell,
      paused: slotRegime.paused,
      reason: slotRegime.reason,
      momentumYes: slotRegime.momentumYes,
      volatilityScore: slotRegime.volatilityScore,
      jevOk: slotRegime.jevOk,
      source: "slot",
    };
  }
  return null;
}

export default function DecisionPanel({ latest, regime }: DecisionPanelProps) {
  const decision = latest?.decision ?? null;
  const late = decision ? decision.late : true;
  const op: Operation | null = !decision || late ? null : (decision.operation ?? null);
  const opProbs = decision?.operationProbabilities ?? null;
  const decided = decision !== null && !late && op !== null;
  const pctOf = (p: number) => (decided ? fmtPct(p) : "-");

  const headline = late ? "LATE" : op ? OP_SHORT[op] : "-";
  const headlineColor =
    op === "BUY_SPOT" || op === "LONG_PERP" ? "var(--buy-ink)"
    : op === "SELL_SPOT" || op === "SHORT_PERP" || op === "PAUSE" ? "var(--sell-ink)"
    : "var(--late-ink)";
  const headlinePct = decided && decision ? fmtPct(decision.confidence) : "";

  // Only the selected operation's slippage target is consumed.
  const targetNote =
    decided && decision && decision.slippageBps != null
      ? `slippage ${decision.slippageBps} bps`
      : null;
  const routeNote =
    decided && decision && decision.venue
      ? `route → ${decision.venue}${decision.executed ? " · filled (sim)" : " · not filled"}`
      : null;

  const gate = gateOf(regime, latest?.regime ?? null);
  const jevFailed = decision ? !decision.jevOk : false;

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <div className={styles.sectionLabel}>TAKER DECISION</div>
        <div className={styles.order}>
          {"> one Jev decision per cycle: BUY_SPOT, SELL_SPOT, LONG_PERP, SHORT_PERP, HOLD, PAUSE. Jev picks the move; size and best-price routing stay in code."}
        </div>
      </section>

      <section className={styles.section}>
        <div className={`${styles.sectionLabel} ${styles.sectionLabelGap}`}>
          DECISION THIS CYCLE?
        </div>

        <div className={styles.headline} style={{ color: headlineColor }}>
          <span className={styles.headlineWord}>{headline}</span>
          {headlinePct ? (
            <span className={styles.headlinePct}>{headlinePct}</span>
          ) : null}
        </div>

        {OPERATIONS.map((id) => (
          <BarRow
            key={id}
            label={OP_SHORT[id].toLowerCase()}
            labelColor="var(--ink-2)"
            active={op === id}
            value={opProbs ? opProbs[id] ?? 0 : 0}
            fill={op === id ? "var(--buy-bar)" : "var(--buy-bar-dim)"}
            pct={opProbs ? pctOf(opProbs[id] ?? 0) : "-"}
          />
        ))}

        {decision && (
          <div className={styles.gates}>
            <GateChip side="buy" status={decision.gate.buy} />
            <GateChip side="sell" status={decision.gate.sell} />
            {targetNote ? (
              <span className={styles.gateChip} title="Slippage tolerance Jev picked from the target menu">
                {targetNote}
              </span>
            ) : null}
            {routeNote ? (
              <span className={styles.gateChip} title="Deterministic venue routing (best-price spot venue or Imperial perps)">
                {routeNote}
              </span>
            ) : null}
            {decision.reason !== "ok" && !late ? (
              <span className={styles.gateChip} title="Machine-readable decision reason">
                {decision.reason}
              </span>
            ) : null}
            {jevFailed ? (
              <span className={styles.jevFail} title="Jev failed; the trader failed closed">
                jev failed — no trade
              </span>
            ) : null}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={`${styles.sectionLabel} ${styles.sectionLabelGap}`}>
          REGIME GATE{gate?.source === "slot" ? " · LAST CYCLE" : ""}
        </div>
        {gate ? (
          <div className={styles.gate}>
            <div className={styles.gateRow}>
              <span className={styles.gateChoice}>{gate.choice}</span>
              <span className={styles.gateConf}>conf {gate.confidence.toFixed(2)}</span>
            </div>
            <div className={styles.gateRow}>
              <span className={gate.allowedBuy ? styles.allowYes : styles.allowNo}>
                buy {gate.allowedBuy ? "allowed" : "blocked"}
              </span>
              <span className={gate.allowedSell ? styles.allowYes : styles.allowNo}>
                sell {gate.allowedSell ? "allowed" : "blocked"}
              </span>
            </div>
            <div className={styles.gateRow}>
              <span>
                momentum{" "}
                {gate.momentumYes == null ? "-" : `up ${Math.round(gate.momentumYes * 100)}%`}
              </span>
              <span>vol {gate.volatilityScore == null ? "-" : gate.volatilityScore}</span>
              <span className={gate.jevOk ? styles.allowYes : styles.allowNo}>
                jev {gate.jevOk ? "ok" : "failed"}
              </span>
            </div>
            <div className={styles.gateReason}>
              {gate.paused ? (
                <span className={styles.gatePaused}>paused — {gate.reason}</span>
              ) : (
                <span className={styles.gateOk}>gate open — {gate.reason}</span>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.gateUnknown}>regime gate unknown — no signal yet</div>
        )}
        <div className={styles.advice}>Model predictions. Not advice.</div>
      </section>
    </div>
  );
}
