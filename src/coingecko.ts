/**
 * CoinGecko free market-data feed for SOL (no API key).
 *
 * Guarantees:
 * - 60s cache TTL; a single in-flight fetch is shared by all consumers.
 * - Never throws into the caller: on failure the last good snapshot is
 *   returned marked stale, or an "unknown" snapshot if we never succeeded.
 * - Every snapshot carries honest freshness info (fetchedAt / ageMs / stale).
 *
 * Free-tier rate limit is respected by the TTL: at most one request per
 * TTL window no matter how many consumers call getCoingecko().
 */

export interface CoingeckoSnapshot {
  source: "coingecko";
  priceUsd: number | null;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  /** ms epoch of the last successful fetch; 0 = never succeeded. */
  fetchedAt: number;
  /** ms since fetchedAt; Infinity when never succeeded. */
  ageMs: number;
  /** true when there is no fresh data inside the TTL (or never any data). */
  stale: boolean;
  /** true once at least one fetch has succeeded. */
  ok: boolean;
}

const MARKETS_URL =
  "https://api.coingecko.com/api/v3/coins/markets" +
  "?vs_currency=usd&ids=solana&price_change_percentage=24h";

const TTL_MS = Number(process.env.COINGECKO_TTL_MS ?? "60000");
const FETCH_TIMEOUT_MS = Number(process.env.COINGECKO_FETCH_TIMEOUT_MS ?? "10000");

interface Raw {
  priceUsd: number | null;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
}

let last: (Raw & { fetchedAt: number }) | null = null;
let inflight: Promise<void> | null = null;

function unknown(): CoingeckoSnapshot {
  return {
    source: "coingecko",
    priceUsd: null, change24hPct: null, high24h: null,
    low24h: null, volume24hUsd: null, marketCapUsd: null,
    fetchedAt: 0, ageMs: Infinity, stale: true, ok: false,
  };
}

function wrap(raw: Raw & { fetchedAt: number }): CoingeckoSnapshot {
  const now = Date.now();
  const ageMs = now - raw.fetchedAt;
  return {
    source: "coingecko",
    priceUsd: raw.priceUsd, change24hPct: raw.change24hPct,
    high24h: raw.high24h, low24h: raw.low24h,
    volume24hUsd: raw.volume24hUsd, marketCapUsd: raw.marketCapUsd,
    fetchedAt: raw.fetchedAt, ageMs,
    stale: ageMs > TTL_MS, ok: true,
  };
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

async function fetchFresh(): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MARKETS_URL, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "jev-trader-solana/1.0" },
    });
    if (!res.ok) throw new Error(`coingecko http ${res.status}`);
    const arr = (await res.json()) as any[];
    const m = arr?.[0];
    if (!m) throw new Error("coingecko: empty markets response");
    last = {
      priceUsd: num(m.current_price),
      change24hPct: num(m.price_change_percentage_24h),
      high24h: num(m.high_24h),
      low24h: num(m.low_24h),
      volume24hUsd: num(m.total_volume),
      marketCapUsd: num(m.market_cap),
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The shared cached snapshot. Resolves with fresh data when the cache is
 * warm; otherwise one fetch is started and shared by concurrent callers.
 * Never rejects: failures keep serving the last good snapshot (stale) or
 * the unknown snapshot.
 */
export async function getCoingecko(): Promise<CoingeckoSnapshot> {
  const now = Date.now();
  if (last && now - last.fetchedAt < TTL_MS) return wrap(last);
  if (!inflight) {
    inflight = fetchFresh()
      .catch((e) => {
        // Swallowed by design: the snapshot below reports staleness honestly.
        console.error("[coingecko] fetch failed:", (e as Error)?.message ?? e);
      })
      .finally(() => { inflight = null; });
  }
  await inflight;
  return last ? wrap(last) : unknown();
}

/** Force a fresh fetch (tests / manual refresh). Still never throws. */
export async function refreshCoingecko(): Promise<CoingeckoSnapshot> {
  last = null;
  return getCoingecko();
}

/** Test-only: reset module state. */
export function _resetCoingeckoForTest() {
  last = null;
  inflight = null;
}
