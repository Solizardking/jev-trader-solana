/**
 * DFlow spot venue feed: SOL-USDC executable price proxy.
 *
 * Read-only, via the dflow skill's Python quote tooling
 * (~/workspace/skills/dflow/bin/dflow_quote.py) over the production
 * `quote-api.dflow.net` `GET /order` endpoint (no userPublicKey, no
 * transaction attached — a price quote only). The skill's own tooling
 * attaches the user's stored `custom.dflow` connector credential through
 * the approved urllib path; this module only parses the tool's printed
 * `inAmount:`/`outAmount:` lines and never touches credentials.
 *
 * IMPORTANT TRANSPORT RULE (from the dflow skill): the connector surrogate
 * substitutes only on the Python urllib path — a raw curl/fetch to
 * quote-api.dflow.net goes out unauthenticated (403). Never fetch DFlow
 * directly from TypeScript; always go through the Python CLI.
 *
 * The bid proxy is the effective price of selling `spotQuoteSizeSol` SOL for
 * USDC; the ask proxy is the effective price of buying it back with USDC.
 * Fail-soft pattern (same as src/jupiter.ts): 10s cache TTL, shared
 * in-flight request, never throws — stale or unknown snapshots carry honest
 * freshness info, and data older than config.dflowStaleMs pauses quoting.
 */

import { homedir } from "node:os";

export interface DflowSnapshot {
  source: "dflow";
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadBps: number | null;
  fetchedAt: number;
  ageMs: number;
  stale: boolean;
  ok: boolean;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TTL_MS = Number(process.env.DFLOW_TTL_MS ?? "10000");
const QUOTE_SIZE_SOL = Number(process.env.SPOT_QUOTE_SIZE_SOL ?? "0.1");
const SUBPROC_TIMEOUT_MS = Number(process.env.DFLOW_SUBPROC_TIMEOUT_MS ?? "15000");
const BIN =
  process.env.DFLOW_QUOTE_BIN ??
  `${homedir()}/workspace/skills/dflow/bin/dflow_quote.py`;

interface Raw { bid: number; ask: number; mid: number; spreadBps: number }

let last: (Raw & { fetchedAt: number }) | null = null;
let inflight: Promise<void> | null = null;

function unknown(): DflowSnapshot {
  return {
    source: "dflow",
    bid: null, ask: null, mid: null, spreadBps: null,
    fetchedAt: 0, ageMs: Infinity, stale: true, ok: false,
  };
}

function wrap(raw: Raw & { fetchedAt: number }): DflowSnapshot {
  const ageMs = Date.now() - raw.fetchedAt;
  return { source: "dflow", ...raw, fetchedAt: raw.fetchedAt, ageMs, stale: ageMs > TTL_MS, ok: true };
}

/** One directional DFlow quote via the skill CLI; returns effective USDC-per-SOL. */
async function quoteEffectivePrice(inputMint: string, outputMint: string, amountAtomic: number): Promise<number> {
  const proc = Bun.spawn(["python3", BIN, inputMint, outputMint, String(amountAtomic)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => { try { proc.kill(); } catch {} }, SUBPROC_TIMEOUT_MS);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  clearTimeout(timeout);
  const exit = await proc.exited;
  if (exit !== 0) {
    const tail = (err || out).trim().split("\n").slice(-3).join(" | ");
    throw new Error(`dflow quote exited ${exit}: ${tail}`);
  }
  const inM = /inAmount:\s*(\d+)/.exec(out);
  const outM = /outAmount:\s*(\d+)/.exec(out);
  const inAmount = inM ? Number(inM[1]) : NaN;
  const outAmount = outM ? Number(outM[1]) : NaN;
  if (!Number.isFinite(inAmount) || inAmount <= 0 || !Number.isFinite(outAmount) || outAmount <= 0) {
    throw new Error(`dflow quote: unparsable output: ${out.trim().slice(0, 160)}`);
  }
  const inDecimals = inputMint === SOL_MINT ? 9 : 6;
  const outDecimals = outputMint === SOL_MINT ? 9 : 6;
  const inUnits = inAmount / 10 ** inDecimals;
  const outUnits = outAmount / 10 ** outDecimals;
  // We always quote in terms of USDC per SOL.
  return inputMint === SOL_MINT ? outUnits / inUnits : inUnits / outUnits;
}

async function fetchFresh(): Promise<void> {
  const sizeLamports = Math.round(QUOTE_SIZE_SOL * 1e9);
  // We need a SOL->USDC quote first to size the USDC leg of the buy quote.
  const bid = await quoteEffectivePrice(SOL_MINT, USDC_MINT, sizeLamports);
  const usdcMicro = Math.round(QUOTE_SIZE_SOL * bid * 1e6);
  const ask = await quoteEffectivePrice(USDC_MINT, SOL_MINT, usdcMicro);
  if (!(bid > 0 && ask > 0)) throw new Error("dflow: non-positive bid-ask proxy");
  const mid = (bid + ask) / 2;
  // Two independently-routed quotes can microscopically cross (sub-bps
  // noise) — tolerate a cross under 10 bps; a larger one is a bad feed.
  if (Math.abs(bid - ask) / mid > 0.001) throw new Error("dflow: crossed bid-ask proxy beyond 10 bps");
  last = {
    bid: Math.min(bid, ask), ask: Math.max(bid, ask), mid,
    spreadBps: Math.max(0, ((ask - bid) / mid) * 10_000),
    fetchedAt: Date.now(),
  };
}

/**
 * The shared cached snapshot. Never rejects: failures keep serving the last
 * good snapshot (stale) or the unknown snapshot.
 */
export async function getDflow(): Promise<DflowSnapshot> {
  const now = Date.now();
  if (last && now - last.fetchedAt < TTL_MS) return wrap(last);
  if (!inflight) {
    inflight = fetchFresh()
      .catch((e) => {
        console.error("[dflow] fetch failed:", (e as Error)?.message ?? e);
      })
      .finally(() => { inflight = null; });
  }
  await inflight;
  return last ? wrap(last) : unknown();
}

/** Force a fresh fetch (tests / manual refresh). Still never throws. */
export async function refreshDflow(): Promise<DflowSnapshot> {
  last = null;
  return getDflow();
}

/** True when the snapshot holds usable data inside the staleness cutoff. */
export function dflowFreshEnough(
  s: DflowSnapshot,
  staleMs = Number(process.env.DFLOW_STALE_MS ?? "300000"),
): boolean {
  return s.ok && s.ageMs <= staleMs;
}

/** Test-only: reset module state. */
export function _resetDflowForTest() {
  last = null;
  inflight = null;
}
