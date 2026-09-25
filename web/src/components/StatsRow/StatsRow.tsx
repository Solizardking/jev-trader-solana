"use client";

import { useEffect, useState } from "react";
import type { BlockEvent, Meta } from "@/lib/types";
import { fmtInt, fmtSigned, fmtSignedPct, fmtSol, uptime } from "@/lib/format";
import styles from "./StatsRow.module.css";

const DASH = "-";

export default function StatsRow({
  latest,
  avgLatencyMs,
  meta,
}: {
  latest: BlockEvent | null;
  avgLatencyMs: number;
  meta: Meta | null;
}) {
  const startedAt = meta?.startedAt ?? null;
  // Ticks once a second; starts on the client so SSR and hydration agree.
  const [up, setUp] = useState<string | null>(null);

  useEffect(() => {
    if (startedAt == null) {
      setUp(null);
      return;
    }
    const tick = () => setUp(uptime(startedAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const decision = latest?.decision ?? null;
  const last = decision && !decision.late ? `${decision.latencyMs} ms` : `${DASH} ms`;
  const avg =
    Number.isFinite(avgLatencyMs) && avgLatencyMs > 0 ? `${Math.round(avgLatencyMs)}ms` : DASH;
  const totals = latest?.totals ?? null;
  const position = latest?.position ?? null;

  const stance =
    !position || position.side === "flat"
      ? "flat"
      : `${position.side} ${fmtSol(position.size, Number.isInteger(position.size) ? 0 : 3)}`;

  const pnl = totals ? `${fmtSigned(totals.pnlUsd)} (${fmtSignedPct(totals.pnlPct)})` : DASH;
  const pnlClass = !totals || totals.pnlUsd >= 0 ? styles.pnlPos : styles.pnlNeg;

  return (
    <div className={styles.stats}>
      <span>last {last}</span>
      <span>avg {avg}</span>
      <span className={styles.nowrap}>{totals ? fmtInt(totals.decisions) : DASH} calls</span>
      <span className={styles.nowrap}>{totals ? fmtInt(totals.fills) : DASH} fills</span>
      <span className={styles.nowrap}>pos {stance}</span>
      <span className={`${styles.nowrap} ${pnlClass}`}>p&amp;l {pnl}</span>
      <span className={styles.spacer} />
      <span>uptime {up ?? "00:00:00"}</span>
    </div>
  );
}
