"use client";

import CoinGeckoPanel from "@/components/CoinGeckoPanel/CoinGeckoPanel";
import DecisionPanel from "@/components/DecisionPanel/DecisionPanel";
import Feed from "@/components/Feed/Feed";
import FlowChart from "@/components/FlowChart/FlowChart";
import Header from "@/components/Header/Header";
import StatsRow from "@/components/StatsRow/StatsRow";
import VenueCards from "@/components/VenueCards/VenueCards";
import { useFeed } from "@/lib/useFeed";
import styles from "./page.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export default function Page() {
  const feed = useFeed(API_URL);

  const regime = feed.regime;
  const slotRegime = feed.latest?.regime ?? null;
  // Prefer the live gate event; fall back to the latest slot's embedded regime.
  const paused = regime ? regime.paused : (slotRegime?.paused ?? false);
  const pauseReason = regime ? regime.reason : slotRegime?.reason;
  const dryRun = feed.meta?.dryRun ?? false;

  return (
    <div className="card">
      <Header meta={feed.meta} latest={feed.latest} connection={feed.connection} />

      {dryRun ? (
        <div className={styles.dryRun} role="status">
          <span className={styles.dryRunBadge}>DRY RUN</span>
          <span>Simulated orders only — no real funds move.</span>
        </div>
      ) : null}

      {paused ? (
        <div className={styles.paused} role="alert">
          <span className={styles.pausedBadge}>PAUSED</span>
          <span>
            Quoting halted{pauseReason && pauseReason !== "ok" ? ` — ${pauseReason}` : ""}. The gate
            fails closed; no new orders until it clears.
          </span>
        </div>
      ) : null}

      <StatsRow latest={feed.latest} avgLatencyMs={feed.avgLatencyMs} meta={feed.meta} />
      <div className={styles.main}>
        <div className={styles.left}>
          <div className={styles.chartWrap}>
            <FlowChart events={feed.events} latest={feed.latest} />
          </div>
        </div>
        <div className={styles.right}>
          <VenueCards latest={feed.latest} />
          <DecisionPanel latest={feed.latest} regime={regime} />
          <CoinGeckoPanel apiUrl={API_URL} />
          <Feed events={feed.events} />
        </div>
      </div>
      <footer className={styles.footer}>
        <span className={styles.footerClawd}>🦞 powered by $CLAWD</span>
        <span className={styles.footerNote}>Not advice. Simulated data until a live server connects.</span>
      </footer>
    </div>
  );
}
