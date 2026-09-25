"use client";

import { useEffect, useRef, useState } from "react";
import type { CoingeckoSnapshot } from "@/lib/types";
import styles from "./CoinGeckoPanel.module.css";

declare global {
  interface Window {
    CoinGeckoCard?: {
      mount: (
        el: HTMLElement,
        fetchSnapshot: () => Promise<CoingeckoSnapshot>,
        intervalMs: number,
      ) => () => void;
    };
  }
}

/**
 * Dashboard panel around the vanilla CoinGecko card widget
 * (public/coingecko-card.js + coingecko-card.css, loaded in layout).
 * The widget polls the trader's /regime snapshot and renders its own honest
 * stale/unknown states — this component only mounts it.
 */
export default function CoinGeckoPanel({ apiUrl }: { apiUrl: string }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef(apiUrl);
  apiRef.current = apiUrl;
  const [scriptMissing, setScriptMissing] = useState(false);

  useEffect(() => {
    const el = elRef.current;
    const widget = typeof window !== "undefined" ? window.CoinGeckoCard : undefined;
    if (!el || !widget) {
      setScriptMissing(true);
      return;
    }
    const fetchSnapshot = async (): Promise<CoingeckoSnapshot> => {
      const base = (apiRef.current || "").replace(/\/+$/, "");
      const r = await fetch(`${base}/regime`);
      if (!r.ok) throw new Error(`regime ${r.status}`);
      const j = await r.json();
      return j.coingecko as CoingeckoSnapshot;
    };
    return widget.mount(el, fetchSnapshot, 15_000);
  }, []);

  return (
    <section className={styles.panel}>
      <div className={styles.label}>SOL · COINGECKO</div>
      <div className={styles.cardWrap}>
        {scriptMissing ? (
          <div className={styles.missing}>
            Price card unavailable — widget script did not load.
          </div>
        ) : null}
        <div ref={elRef} />
      </div>
    </section>
  );
}
