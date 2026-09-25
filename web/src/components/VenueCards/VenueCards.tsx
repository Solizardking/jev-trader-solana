"use client";

import type { BlockEvent, PerpView, VenueView } from "@/lib/types";
import styles from "./VenueCards.module.css";

export interface VenueCardsProps {
  latest: BlockEvent | null;
}

const fmtPx = (p: number) => `$${p.toFixed(2)}`;
const fmtBps = (b: number) => `${b.toFixed(1)} bps`;

function SpotCard({
  name,
  view,
  isBestBid,
  isBestAsk,
}: {
  name: string;
  view: VenueView | null;
  isBestBid: boolean;
  isBestAsk: boolean;
}) {
  if (!view) {
    return (
      <div className={styles.card}>
        <div className={styles.cardName}>
          <span>{name}</span>
        </div>
        <div className={styles.dim}>no data yet</div>
      </div>
    );
  }
  const ageSec = Math.round(view.ageMs / 1000);
  return (
    <div className={`${styles.card}${view.stale ? ` ${styles.stale}` : ""}`}>
      <div className={styles.cardName}>
        <span>{name}</span>
        <span className={styles.best}>
          {isBestBid && isBestAsk ? "best" : isBestBid ? "best bid" : isBestAsk ? "best ask" : ""}
        </span>
      </div>
      <div className={styles.quote}>
        <span className={styles.bidLabel}>bid {fmtPx(view.bid)}</span>
        <span className={styles.askLabel}>ask {fmtPx(view.ask)}</span>
      </div>
      <div className={styles.spread}>
        mid {fmtPx(view.mid)} · spread {fmtBps(view.spreadBps)}
      </div>
      <div className={styles.status}>
        {view.stale ? `stale — ${ageSec}s old` : view.ok ? `live · ${ageSec}s old` : "feed down"}
      </div>
    </div>
  );
}

function PerpCard({ view, perp }: { view: PerpView | null; perp: BlockEvent["perp"] }) {
  const funding =
    view?.fundingPerHourPct != null ? `${(view.fundingPerHourPct * 100).toFixed(4)}%/h` : "—";
  const oi = view?.openInterestUsd != null ? `$${Math.round(view.openInterestUsd).toLocaleString("en-US")}` : "—";
  const side = perp?.side ?? "flat";
  const sideClass =
    side === "long" ? styles.posLong : side === "short" ? styles.posShort : styles.dim;
  const u = perp?.unrealizedUsd ?? 0;
  const pnlClass = u >= 0 ? styles.pnlPos : styles.pnlNeg;

  return (
    <div className={styles.perp}>
      <div className={styles.perpTitle}>IMPERIAL · SOL PERPS (PHOENIX-ROUTED, 1X)</div>
      <div className={styles.perpRows}>
        <span className={styles.dim}>mark {view ? fmtPx(view.mark) : "—"}</span>
        <span className={styles.dim}>spread {view ? fmtBps(view.spreadBps) : "—"}</span>
        <span className={styles.dim}>funding {funding}</span>
        <span className={styles.dim}>open interest {oi}</span>
        <span className={styles.dim}>
          position <span className={sideClass}>{side}</span>
          {perp && perp.size > 0 ? ` ${perp.size.toFixed(2)} @ ${fmtPx(perp.entryPrice ?? 0)}` : ""}
        </span>
        <span className={styles.dim}>
          unrealized <span className={pnlClass}>{u >= 0 ? "+" : ""}{u.toFixed(2)}</span>
        </span>
      </div>
    </div>
  );
}

export default function VenueCards({ latest }: VenueCardsProps) {
  const jupiter = latest?.venues?.jupiter ?? null;
  const dflow = latest?.venues?.dflow ?? null;
  const imperial = latest?.venues?.imperial ?? null;
  const perp = latest?.perp ?? null;

  const bestBid = Math.max(jupiter?.bid ?? -Infinity, dflow?.bid ?? -Infinity);
  const bestAsk = Math.min(jupiter?.ask ?? Infinity, dflow?.ask ?? Infinity);

  return (
    <section className={styles.panel}>
      <div className={styles.label}>VENUES · SPOT BEST EXECUTION (JUPITER + DFLOW)</div>
      <div className={styles.cards}>
        <SpotCard
          name="JUPITER"
          view={jupiter}
          isBestBid={jupiter != null && jupiter.bid === bestBid}
          isBestAsk={jupiter != null && jupiter.ask === bestAsk}
        />
        <SpotCard
          name="DFLOW"
          view={dflow}
          isBestBid={dflow != null && dflow.bid === bestBid}
          isBestAsk={dflow != null && dflow.ask === bestAsk}
        />
      </div>
      <PerpCard view={imperial} perp={perp} />
    </section>
  );
}
