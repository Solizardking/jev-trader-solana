/**
 * Stonk.fun public market data reader.
 *
 * Reads are keyless. Launches and fee claims use prepare -> local signing ->
 * submit flows and are deliberately not implemented in this dry-run trader.
 */
import { config } from "./config";

export interface StonkSnapshot {
  source: "stonkfun";
  ok: boolean;
  fetchedAt: number;
  ageMs: number;
  stale: boolean;
  error: string | null;
  tokens: unknown[];
}

let last: StonkSnapshot | null = null;
let inflight: Promise<StonkSnapshot> | null = null;

async function getJson(path: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.stonkFetchTimeoutMs);
  try {
    const res = await fetch(`${config.stonkBaseUrl}${path}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "jev-trader-solana/1.0" },
    });
    if (!res.ok) throw new Error(`stonkfun http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const dataOf = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const outer = body as Record<string, unknown>;
  const data = outer.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : outer;
};

async function fetchFresh(): Promise<StonkSnapshot> {
  const body = await getJson("/tokens?sort=newest&pageSize=20");
  const data = dataOf(body);
  const tokens = Array.isArray(data.tokens) ? data.tokens : Array.isArray(data.items) ? data.items : [];
  return {
    source: "stonkfun",
    ok: true,
    fetchedAt: Date.now(),
    ageMs: 0,
    stale: false,
    error: null,
    tokens,
  };
}

function wrap(snapshot: StonkSnapshot): StonkSnapshot {
  const ageMs = Date.now() - snapshot.fetchedAt;
  return { ...snapshot, ageMs, stale: ageMs > config.stonkTtlMs };
}

export async function getStonkSnapshot(): Promise<StonkSnapshot> {
  if (last && Date.now() - last.fetchedAt < config.stonkTtlMs) return wrap(last);
  if (!inflight) {
    inflight = fetchFresh()
      .then((snapshot) => {
        last = snapshot;
        return snapshot;
      })
      .catch((error) => {
        const fallback: StonkSnapshot = last
          ? { ...wrap(last), error: (error as Error).message }
          : {
              source: "stonkfun",
              ok: false,
              fetchedAt: 0,
              ageMs: Infinity,
              stale: true,
              error: (error as Error).message,
              tokens: [],
            };
        return fallback;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
