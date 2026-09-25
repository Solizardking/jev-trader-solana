/**
 * Imperial perps venue feed: Phoenix-routed SOL perps state (observe mode).
 *
 * Public endpoints only (no JWT, no auth — this module never places orders,
 * deposits, or touches any credential):
 *   GET https://api.imperial.space/api/v1/phoenix/depth?symbol=SOL  — top of book
 *   GET https://api.imperial.space/api/v1/funding-rates              — per-venue funding
 *   GET https://api.imperial.space/api/v1/mark-prices                — per-venue mark
 *   GET https://api.imperial.space/api/v1/stats/open-interest        — OI (context)
 *
 * Sign convention (per the imperial skill): longFundingRatePerHourPercent > 0
 * means longs pay shorts. The Phoenix underwriter block is used (the skill's
 * documented venue preference).
 *
 * Fail-soft pattern (same as src/jupiter.ts): 10s cache TTL, shared
 * in-flight request, never throws — stale or unknown snapshots carry honest
 * freshness info, and data older than config.imperialStaleMs blocks perp
 * trades in the trader's risk code.
 */

export interface ImperialSnapshot {
  source: "imperial";
  /** Perps mark: Imperial's Phoenix top-of-book mid. */
  mark: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadBps: number | null;
  /** Signed hourly funding rate, percent: >0 = longs pay shorts. */
  fundingPerHourPct: number | null;
  /** Phoenix-venue open interest, USD (context only). */
  openInterestUsd: number | null;
  fetchedAt: number;
  ageMs: number;
  stale: boolean;
  ok: boolean;
}

const BASE = (process.env.IMPERIAL_BASE_URL ?? "https://api.imperial.space").replace(/\/$/, "");
const TTL_MS = Number(process.env.IMPERIAL_TTL_MS ?? "10000");
const FETCH_TIMEOUT_MS = Number(process.env.IMPERIAL_FETCH_TIMEOUT_MS ?? "12000");

interface Raw {
  mark: number; bid: number; ask: number; mid: number; spreadBps: number;
  fundingPerHourPct: number | null; openInterestUsd: number | null;
}

let last: (Raw & { fetchedAt: number }) | null = null;
let inflight: Promise<void> | null = null;

function unknown(): ImperialSnapshot {
  return {
    source: "imperial",
    mark: null, bid: null, ask: null, mid: null, spreadBps: null,
    fundingPerHourPct: null, openInterestUsd: null,
    fetchedAt: 0, ageMs: Infinity, stale: true, ok: false,
  };
}

function wrap(raw: Raw & { fetchedAt: number }): ImperialSnapshot {
  const ageMs = Date.now() - raw.fetchedAt;
  return { source: "imperial", ...raw, fetchedAt: raw.fetchedAt, ageMs, stale: ageMs > TTL_MS, ok: true };
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
    if (!res.ok) throw new Error(`imperial http ${res.status} for ${url.split("?")[0]}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFresh(): Promise<void> {
  const [depth, funding, oi] = await Promise.all([
    getJson(`${BASE}/api/v1/phoenix/depth?symbol=SOL`),
    getJson(`${BASE}/api/v1/funding-rates`),
    getJson(`${BASE}/api/v1/stats/open-interest`).catch(() => null), // OI is context-only; never hard-fails the feed
  ]);
  const snap = depth?.snapshots?.SOL;
  const bid = num(snap?.bids?.[0]?.price);
  const ask = num(snap?.asks?.[0]?.price);
  const mid = num(snap?.mid);
  if (bid == null || ask == null || mid == null || !(bid > 0 && ask > 0 && bid <= ask)) {
    throw new Error("imperial: malformed phoenix depth for SOL");
  }
  const solRow = (funding?.rows ?? []).find((r: any) => String(r?.symbol).toUpperCase() === "SOL");
  const fundingPerHourPct = num(solRow?.phoenix?.longFundingRatePerHourPercent);
  let openInterestUsd: number | null = null;
  const rows = oi?.rows ?? [];
  const phoenixOi = rows.find((r: any) => String(r?.label).toLowerCase() === "phoenix");
  openInterestUsd = num(phoenixOi?.totalUsd != null ? Number(phoenixOi.totalUsd) : null);
  last = {
    mark: mid, bid, ask, mid,
    spreadBps: ((ask - bid) / mid) * 10_000,
    fundingPerHourPct, // may be null: funding unknown then
    openInterestUsd,   // may be null: context only
    fetchedAt: Date.now(),
  };
}

/**
 * The shared cached snapshot. Never rejects: failures keep serving the last
 * good snapshot (stale) or the unknown snapshot.
 */
export async function getImperial(): Promise<ImperialSnapshot> {
  const now = Date.now();
  if (last && now - last.fetchedAt < TTL_MS) return wrap(last);
  if (!inflight) {
    inflight = fetchFresh()
      .catch((e) => {
        console.error("[imperial] fetch failed:", (e as Error)?.message ?? e);
      })
      .finally(() => { inflight = null; });
  }
  await inflight;
  return last ? wrap(last) : unknown();
}

/** Force a fresh fetch (tests / manual refresh). Still never throws. */
export async function refreshImperial(): Promise<ImperialSnapshot> {
  last = null;
  return getImperial();
}

/** True when the snapshot holds usable data inside the staleness cutoff. */
export function imperialFreshEnough(
  s: ImperialSnapshot,
  staleMs = Number(process.env.IMPERIAL_STALE_MS ?? "300000"),
): boolean {
  return s.ok && s.ageMs <= staleMs;
}

/** Test-only: reset module state. */
export function _resetImperialForTest() {
  last = null;
  inflight = null;
}
