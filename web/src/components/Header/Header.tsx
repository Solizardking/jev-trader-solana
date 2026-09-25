"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockEvent, ConnectionState, Meta } from "@/lib/types";
import { fmtInt, shortAddr } from "@/lib/format";
import styles from "./Header.module.css";

export interface HeaderProps {
  meta: Meta | null;
  latest: BlockEvent | null;
  connection: ConnectionState;
}

/** Only shown when we are NOT live. Live is the silent, default state. */
const OFFLINE_LABEL: Partial<Record<ConnectionState, string>> = {
  connecting: "Connecting…",
  reconnecting: "Disconnected — reconnecting…",
};

export default function Header({ meta, latest, connection }: HeaderProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const wallet = meta?.wallet ?? null;

  const onCopy = useCallback(() => {
    if (!wallet) return;
    try {
      void navigator.clipboard?.writeText(wallet)?.catch(() => {});
    } catch {
      /* clipboard unavailable, still flash "copied" so the click feels alive */
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  }, [wallet]);

  const model = meta?.model ?? null;
  const isMock = (model ?? "").toLowerCase() === "mock";
  const isJev = (model ?? "").toLowerCase().startsWith("jev");
  const offline = OFFLINE_LABEL[connection] ?? null;

  const badgeText = isMock ? "Stand-in model" : model;
  const badgeTitle = isMock
    ? "Stand-in model: decisions are simulated, not real Jev"
    : isJev
      ? "TypeSafe Jev — live typed judgments"
      : (model ?? undefined);

  return (
    <div className={styles.header}>
      <span className={styles.brand}>
        <span className={styles.claw} role="img" aria-label="Clawd the lobster">
          🦞
        </span>{" "}
        Clawd JEV Trader
      </span>

      <span className={styles.sub}>SOL-USDC · Jupiter + DFlow · Imperial perps</span>

      <span className={styles.block}>slot {latest ? fmtInt(latest.slot) : "-"}</span>

      <span className={styles.spacer} />

      {offline ? <span className={styles.offline}>{offline}</span> : null}

      <button
        type="button"
        className={styles.wallet}
        onClick={onCopy}
        disabled={!wallet}
        title={wallet ?? "no wallet, dry run"}
        aria-label={wallet ? `Copy wallet address ${wallet}` : "Dry run"}
      >
        {copied ? "copied" : wallet ? shortAddr(wallet) : "dry run"}
      </button>

      {badgeText ? (
        <span
          className={styles.badge}
          title={badgeTitle}
          style={{
            background: isMock ? "var(--badge-standin-bg)" : "var(--badge-jev-bg)",
            color: isMock ? "var(--badge-standin-fg)" : "var(--badge-jev-fg)",
          }}
        >
          {badgeText}
        </span>
      ) : null}
    </div>
  );
}
