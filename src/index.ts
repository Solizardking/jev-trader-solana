/**
 * Clawd JEV trader — multi-venue taker (dry run):
 *   spot: Jupiter + DFlow SOL-USDC, deterministic best-price routing in code
 *   perps: Imperial Phoenix-routed SOL perps, 1x, observe mode (read-only)
 *
 * Every cycle (timer-driven): venue feeds -> freshness gates -> Jev regime
 * gate -> ONE Jev request (operation + slippage target) -> deterministic
 * risk limits -> simulated fills at the best executable price.
 * Jev chooses direction + venue/market + slippage tolerance — never size.
 * Size stays deterministic in code (config + position caps). Code controls
 * execution; Jev supplies typed judgments only.
 *
 * DRY RUN ONLY: real quotes, real decisions, simulated fills. No wallet is
 * created/loaded/touched, nothing is signed or submitted. Live signing is
 * disabled in this build.
 */
import { config } from "./config";
import { askJev } from "./jev";
import { mockAskJev, type AskFn } from "./decision";
import { Trader } from "./trader";
import { startServer } from "./server";

if (config.venue === "phoenix") {
  console.log(
    "[deprecation] VENUE=phoenix is retired: the Phoenix SOL-USDC spot book is fossilized and the old market-maker path no longer runs. " +
    "Use the probe scripts (test-book, test-trades) against src/book.ts / src/trades.ts for the deprecated path. Running multi-venue instead.",
  );
}

// MODEL=jev -> real Jev via the jev.py bridge (custom.typesafe connector).
// MODEL=mock -> deterministic stand-in (honest label; never real Jev).
const ask: AskFn = config.model === "jev" ? askJev : mockAskJev;
const modelName = config.model === "jev" ? config.jevModelId : "mock";

const server = startServer(
  {
    model: modelName,
    wallet: "dry-run (no wallet)",
    dryRun: config.dryRun,
    market: "multi-venue: jupiter+dflow spot · imperial perps",
    venue: config.venue,
    startedAt: Date.now(),
  },
  () => trader.history,
  () => trader.regime,
);

const trader = new Trader(
  ask,
  (e, t) => {
    server.broadcast(e);
    if (e.decision && !e.decision.late) {
      const d = e.decision;
      const q = e.quote;
      const r = e.regime;
      const quote = !q
        ? (r?.paused ? ` NO QUOTE (regime paused: ${r.reason})` : ` NO QUOTE (${d.operation}${d.jevOk ? "" : " jev-failed"}${d.reason !== "ok" ? ` ${d.reason}` : ""})`)
        : ` ${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(3)}${q.status === "sim" ? " (sim)" : ""}`;
      console.log(
        `#${e.slot} spot ${e.mid.toFixed(3)} ${d.operation}${d.venue ? ` via ${d.venue}` : ""}${d.slippageBps != null ? ` s${d.slippageBps}` : ""} ` +
        `conf ${(d.confidence * 100).toFixed(0)}${d.jevOk ? "" : " JEV-FAILED"}${d.executed ? "" : " not-executed"} ${d.latencyMs}ms${quote} ` +
        `perp ${e.perp?.side} ${e.perp?.size} pnl $${e.totals.pnlUsd}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`,
      );
    } else if (e.decision?.late) {
      console.log(`#${e.slot} late (${e.decision.reason})`);
    }
  },
  (slot, fill) => {
    server.broadcastFill(slot, fill);
    console.log(`#${slot} FILL ${fill.side} ${fill.size} @ ${fill.price.toFixed(3)} (sim)`);
  },
  (slot, quote) => {
    server.broadcastQuote(slot, quote);
    if (quote.status !== "sim") console.log(`#${slot} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price.toFixed(3)}`);
  },
  (g) => {
    server.broadcastRegime(g);
    console.log(`[regime] ${g.regime.choice} (${g.regime.confidence.toFixed(2)}) paused=${g.paused} reason=${g.reason}`);
  },
);

console.log(
  `clawd-jev-trader · model=${modelName} · one Jev decision per cycle (operation + slippage; size set by code) · ` +
  `venues: jupiter+dflow spot (best-price), imperial perps (1x, observe) · cycle ${config.cycleMs}ms · ` +
  `${config.dryRun ? "DRY RUN" : "LIVE (disabled)"} · :${config.port}`,
);

let cycle = 0;
setInterval(() => trader.onCycle(cycle++), config.cycleMs);
void trader.onCycle(cycle++);
