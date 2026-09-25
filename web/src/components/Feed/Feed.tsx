"use client";

import { useEffect, useRef, useState } from "react";
import type { BlockEvent, Operation } from "@/lib/types";
import { fmtInt, fmtPrice, shortTx, txUrl } from "@/lib/format";
import styles from "./Feed.module.css";

/** Must match `.row { height }` in Feed.module.css. */
const ROW_H = 26;
/** Hard ceiling, so a very tall viewport does not render an absurd list. */
const MAX_ROWS = 40;

type Kind = "buyspot" | "sellspot" | "longperp" | "shortperp" | "hold" | "pause" | "late";

function kindOf(event: BlockEvent): Kind {
  const d = event.decision;
  if (!d || d.late) return "late";
  const op: Operation | undefined = d.operation;
  switch (op) {
    case "BUY_SPOT": return "buyspot";
    case "SELL_SPOT": return "sellspot";
    case "LONG_PERP": return "longperp";
    case "SHORT_PERP": return "shortperp";
    case "PAUSE": return "pause";
    default: return "hold";
  }
}

function fmtSize(size: number): string {
  return size.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const KIND_CLASS: Record<Kind, string> = {
  buyspot: styles.kindBuy,
  sellspot: styles.kindSell,
  longperp: styles.kindBuy,
  shortperp: styles.kindSell,
  hold: styles.kindLate,
  pause: styles.kindSell,
  late: styles.kindLate,
};

const WORD: Record<Kind, string> = {
  buyspot: "BUY SPOT",
  sellspot: "SELL SPOT",
  longperp: "LONG PERP",
  shortperp: "SHORT PERP",
  hold: "HOLD",
  pause: "PAUSE",
  late: "LATE",
};

/**
 * One row per cycle. The word is the operation Jev picked, the detail is the
 * simulated taker fill that landed (spot routed to the best-price venue,
 * perps to Imperial), or the reason it didn't.
 */
export default function Feed({ events }: { events: BlockEvent[] }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // How many whole 26px rows fit in the box the layout gives us. The list
  // itself clips, so a wrong guess is never a half-drawn row, only a hidden one.
  const [capacity, setCapacity] = useState(MAX_ROWS);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const measure = () => {
      const fits = Math.max(1, Math.min(MAX_ROWS, Math.floor(el.clientHeight / ROW_H)));
      setCapacity((prev) => (prev === fits ? prev : fits));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = events.slice(-capacity).reverse();

  return (
    <section className={styles.feed}>
      <div className={styles.label}>FEED</div>
      <div className={styles.list} ref={listRef}>
        {rows.length === 0 ? (
          <div className={styles.empty}>no slots yet</div>
        ) : (
          rows.map((event, i) => {
            const kind = kindOf(event);
            const decision = event.decision;
            // QUOTE_BOTH events carry both quotes; older events only `quote`.
            const quotes = event.quotes?.length ? event.quotes : event.quote ? [event.quote] : [];
            const quote = quotes[0] ?? null;
            const fill = event.fill;
            const decided = kind !== "late";
            const kindClass = KIND_CLASS[kind];

            const conf =
              !decided || !decision ? "" : "conf " + decision.confidence.toFixed(2);

            const lat = !decided || !decision ? "" : `${decision.latencyMs}ms`;

            let detail = "";
            let detailMuted = false;
            const venue = decided && decision?.venue ? ` @ ${decision.venue}` : "";
            if (fill && fill.size > 0) {
              detail = `FILL ${fmtSize(fill.size)} @ ${fmtPrice(fill.price)}${venue} · sim`;
            } else if (decided && quotes.length) {
              const parts = quotes.map((q) => {
                const word = q.side === "buy" ? "buy" : "sell";
                return `${word} ${fmtSize(q.size)} @ ${fmtPrice(q.price)}${venue}`;
              });
              detail = parts.join(" · ");
              detailMuted = quotes.every((q) => q.status === "reverted" || q.status === "lost");
            } else if (decided) {
              detail = decision?.reason ?? "no fill";
              detailMuted = true;
            }

            const rowClass = [styles.row, kindClass, i === 0 ? styles.newest : "", fill ? styles.filled : ""]
              .filter(Boolean)
              .join(" ");

            return (
              <div key={event.slot} className={rowClass}>
                <span className={`${styles.cell} ${styles.slot}`}>{fmtInt(event.slot)}</span>
                <span className={`${styles.cell} ${styles.word}`}>{WORD[kind]}</span>
                <span className={`${styles.cell} ${styles.conf}`}>{conf}</span>
                <span className={`${styles.cell} ${styles.lat}`}>{lat}</span>
                <span
                  className={`${styles.cell} ${styles.detail}${detailMuted ? ` ${styles.muted}` : ""}`}
                >
                  {detail}
                </span>
                <span className={`${styles.cell} ${styles.tx}`}>
                  {fill && !fill.simulated && fill.txHash ? (
                    <a href={txUrl(fill.txHash)} target="_blank" rel="noreferrer" title="the taker's transaction (Solscan)">
                      {shortTx(fill.txHash)}
                    </a>
                  ) : quote && quote.status === "sim" ? (
                    <span className={styles.muted}>sim</span>
                  ) : quote && quote.txHash ? (
                    <a
                      className={quote.status === "sent" ? styles.pending : quote.status === "placed" ? undefined : styles.muted}
                      title={quote.status}
                      href={txUrl(quote.txHash)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {quote.status === "reverted" ? "rev" : quote.status === "lost" ? "lost" : shortTx(quote.txHash)}
                    </a>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
