/**
 * Jupiter spot venue feed: SOL-USDC executable price proxy.
 *
 * Endpoints (all keyless on the Lite API — the trader's venue, same as the
 * Musebook swap widget's pricing path):
 *   GET https://lite-api.jup.ag/price/v3?ids=<mints>        — reference price
 *   GET https://lite-api.jup.ag/swap/v1/quote?...            — executable quotes
 *
 * The bid proxy is the effective price of selling `spotQuoteSizeSol` SOL for
 * USDC; the ask proxy is the effective price of buying it back with USDC.
 * Two-sided, derived from real routed quotes — no wallet, no signing, no
 * submission. This module only READS.
 *
 * Guarantees (same fail-soft pattern as src/coingecko.ts):
 * - cache TTL; a single in-flight fetch is shared by all consumers.
 * - Never throws into the caller: on failure the last good snapshot is
 *   returned marked stale, or an "unknown" snapshot if we never succeeded.
 * - Every snapshot carries honest freshness info (fetchedAt / ageMs /
 *   stale / ok). Data older than config.jupiterStaleMs pauses quoting.
 */

export interface JupiterSnapshot {
  source: "jupiter";
  /** Effective USDC-per-SOL sell price for spotQuoteSizeSol SOL (Jupiter-routed). */
  bid: number | null;
  /** Effective USDC-per-SOL buy price for spotQuoteSizeSol SOL (Jupiter-routed). */
  ask: number | null;
  mid: number | null;
  spreadBps: number | null;
  /** Reference spot price from the Lite price API. */
  refPriceUsd: number | null;
  /** ms epoch of the last successful fetch; 0 = never succeeded. */
  fetchedAt: number;
  /** ms since fetchedAt; Infinity when never succeeded. */
  ageMs: number;
  /** true when there is no fresh data inside the TTL (or never any data). */
  stale: boolean;
  /** true once at least one fetch has succeeded. */
  ok: boolean;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const BASE = (process.env.JUPITER_BASE_URL ?? "https://lite-api.jup.ag").replace(/\/$/, "");
const TTL_MS = Number(process.env.JUPITER_TTL_MS ?? "10000");
const FETCH_TIMEOUT_MS = Number(process.env.JUPITER_FETCH_TIMEOUT_MS ?? "12000");
const QUOTE_SIZE_SOL = Number(process.env.SPOT_QUOTE_SIZE_SOL ?? "0.1");

interface Raw { bid: number; ask: number; mid: number; spreadBps: number; refPriceUsd: number }

let last: (Raw & { fetchedAt: number }) | null = null;
let inflight: Promise<void> | null = null;

function unknown(): JupiterSnapshot {
  return {
    source: "jupiter",
    bid: null, ask: null, mid: null, spreadBps: null, refPriceUsd: null,
    fetchedAt: 0, ageMs: Infinity, stale: true, ok: false,
  };
}

function wrap(raw: Raw & { fetchedAt: number }): JupiterSnapshot {
  const ageMs = Date.now() - raw.fetchedAt;
  return { source: "jupiter", ...raw, fetchedAt: raw.fetchedAt, ageMs, stale: ageMs > TTL_MS, ok: true };
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

async function getJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "jev-trader-solana/1.0" },
    });
    if (!res.ok) throw new Error(`jupiter http ${res.status} for ${url.split("?")[0]}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFresh(): Promise<void> {
  const sizeLamports = Math.round(QUOTE_SIZE_SOL * 1e9);
  // 1. reference price (also needed to size the USDC leg of the buy quote).
  const priceJson = await getJson(`${BASE}/price/v3?ids=${SOL_MINT},${USDC_MINT}`);
  const refPriceUsd = num(priceJson?.[SOL_MINT]?.usdPrice);
  if (refPriceUsd == null || refPriceUsd <= 0) throw new Error("jupiter: no SOL reference price");
  const usdcMicro = Math.round(QUOTE_SIZE_SOL * refPriceUsd * 1e6);

  // 2. both routed quotes in parallel: sell SOL->USDC (bid proxy), buy USDC->SOL (ask proxy).
  const [sellQ, buyQ] = await Promise.all([
    getJson(`${BASE}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${sizeLamports}&slippageBps=50`),
    getJson(`${BASE}/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${usdcMicro}&slippageBps=50`),
  ]);
  const sellOut = Number(sellQ?.outAmount);
  const sellIn = Number(sellQ?.inAmount);
  const buyOut = Number(buyQ?.outAmount);
  const buyIn = Number(buyQ?.inAmount);
  if (![sellOut, sellIn, buyOut, buyIn].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("jupiter: malformed quote response");
  }
  const bid = (sellOut / 1e6) / (sellIn / 1e9); // USDC per SOL received selling
  const ask = (buyIn / 1e6) / (buyOut / 1e9);   // USDC per SOL paid buying
  if (!(bid > 0 && ask > 0)) throw new Error("jupiter: non-positive bid-ask proxy");
  const mid = (bid + ask) / 2;
  // Two independently-routed quotes can microscopically cross (sub-bps
  // noise across route legs) — tolerate a cross under 10 bps; a larger one
  // is a genuinely bad feed and fails.
  if (Math.abs(bid - ask) / mid > 0.001) throw new Error("jupiter: crossed bid-ask proxy beyond 10 bps");
  last = {
    bid: Math.min(bid, ask), ask: Math.max(bid, ask), mid,
    spreadBps: Math.max(0, ((ask - bid) / mid) * 10_000),
    refPriceUsd,
    fetchedAt: Date.now(),
  };
}

/**
 * The shared cached snapshot. Never rejects: failures keep serving the last
 * good snapshot (stale) or the unknown snapshot.
 */
export async function getJupiter(): Promise<JupiterSnapshot> {
  const now = Date.now();
  if (last && now - last.fetchedAt < TTL_MS) return wrap(last);
  if (!inflight) {
    inflight = fetchFresh()
      .catch((e) => {
        console.error("[jupiter] fetch failed:", (e as Error)?.message ?? e);
      })
      .finally(() => { inflight = null; });
  }
  await inflight;
  return last ? wrap(last) : unknown();
}

/** Force a fresh fetch (tests / manual refresh). Still never throws. */
export async function refreshJupiter(): Promise<JupiterSnapshot> {
  last = null;
  return getJupiter();
}

/** True when the snapshot holds usable data inside the staleness cutoff. */
export function jupiterFreshEnough(
  s: JupiterSnapshot,
  staleMs = Number(process.env.JUPITER_STALE_MS ?? "300000"),
): boolean {
  return s.ok && s.ageMs <= staleMs;
}

/** Test-only: reset module state. */
export function _resetJupiterForTest() {
  last = null;
  inflight = null;
}
