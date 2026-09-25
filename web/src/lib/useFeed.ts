"use client";

import { useEffect, useReducer } from "react";
import type { BlockEvent, ConnectionState, FeedState, Fill, Meta, Quote, RegimeEvent } from "./types";

export { useUptime } from "./useUptime";

/** Max block events kept in memory (oldest -> newest). */
const CAP = 1000;
/** Reconnect backoff, doubling from 1s up to 10s. */
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 10_000;
/** If nothing arrives for this long (server pings every few seconds), force a reconnect. */
const STALE_MS = 45_000;
/** Refresh the regime gate over plain GET while SSE regime events are the live source. */
const REGIME_REFRESH_MS = 30_000;

interface State extends FeedState {
  /** running accumulators so avgLatencyMs stays O(1) per event */
  latSum: number;
  latCount: number;
}

type Action =
  | { type: "snapshot"; meta: Meta | null; history: BlockEvent[] }
  | { type: "block"; event: BlockEvent }
  | { type: "fill"; slot: number; fill: Fill }
  | { type: "quote"; slot: number; quote: Quote }
  | { type: "regime"; regime: RegimeEvent }
  | { type: "connection"; connection: ConnectionState };

const initialState: State = {
  meta: null,
  events: [],
  latest: null,
  regime: null,
  connection: "connecting",
  avgLatencyMs: 0,
  latSum: 0,
  latCount: 0,
};

/** latencyMs of a decided (non-late) slot, or null if it should not count. */
function latencyOf(e: BlockEvent): number | null {
  const d = e?.decision;
  if (!d || d.late || typeof d.latencyMs !== "number" || !Number.isFinite(d.latencyMs)) return null;
  return d.latencyMs;
}

function indexOfSlot(events: BlockEvent[], slot: number): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].slot === slot) return i;
  return -1;
}

function avg(latSum: number, latCount: number): number {
  return latCount > 0 ? Math.round(latSum / latCount) : 0;
}

function isRegimeEvent(x: unknown): x is RegimeEvent {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return r.type === "regime" && typeof r.paused === "boolean";
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "connection":
      return state.connection === action.connection ? state : { ...state, connection: action.connection };

    case "regime":
      return state.regime === action.regime ? state : { ...state, regime: action.regime };

    case "snapshot": {
      const history = Array.isArray(action.history) ? action.history : [];
      // Backfill fields added with the operation decision contract (older
      // events lack them; derive rather than crash).
      const normalized = history.map((e) =>
        e.quotes ? e : { ...e, quotes: e.quote ? [e.quote] : [] },
      );
      const events = normalized.length > CAP ? normalized.slice(normalized.length - CAP) : normalized;
      let latSum = 0;
      let latCount = 0;
      for (const e of events) {
        const l = latencyOf(e);
        if (l !== null) {
          latSum += l;
          latCount++;
        }
      }
      return {
        meta: action.meta ?? state.meta,
        events,
        latest: events.length ? events[events.length - 1] : null,
        regime: state.regime,
        connection: "live",
        avgLatencyMs: avg(latSum, latCount),
        latSum,
        latCount,
      };
    }

    case "block": {
      const ev = action.event;
      if (!ev || typeof ev.slot !== "number") return state;
      const prev = state.events;
      const last = prev.length ? prev[prev.length - 1] : null;

      // Dedupe: a re-sent slot replaces the one we already have; a stale older slot is dropped.
      if (last && ev.slot <= last.slot) {
        const idx = indexOfSlot(prev, ev.slot);
        if (idx < 0) return state;
        const events = prev.slice();
        const old = events[idx];
        events[idx] = ev;
        let latSum = state.latSum;
        let latCount = state.latCount;
        const o = latencyOf(old);
        if (o !== null) {
          latSum -= o;
          latCount--;
        }
        const n = latencyOf(ev);
        if (n !== null) {
          latSum += n;
          latCount++;
        }
        return {
          ...state,
          events,
          latest: events[events.length - 1],
          avgLatencyMs: avg(latSum, latCount),
          latSum,
          latCount,
        };
      }

      let latSum = state.latSum;
      let latCount = state.latCount;
      const n = latencyOf(ev);
      if (n !== null) {
        latSum += n;
        latCount++;
      }
      let events = prev.concat(ev);
      if (events.length > CAP) {
        const drop = events.length - CAP;
        for (let i = 0; i < drop; i++) {
          const l = latencyOf(events[i]);
          if (l !== null) {
            latSum -= l;
            latCount--;
          }
        }
        events = events.slice(drop); // only ever slices once we are over the cap
      }
      return {
        ...state,
        events,
        latest: ev,
        avgLatencyMs: avg(latSum, latCount),
        latSum,
        latCount,
      };
    }

    case "fill": {
      const idx = indexOfSlot(state.events, action.slot);
      if (idx < 0) return state;
      const events = state.events.slice();
      const updated: BlockEvent = { ...events[idx], fill: action.fill };
      events[idx] = updated;
      return {
        ...state,
        events,
        latest: idx === events.length - 1 ? updated : state.latest,
      };
    }

    case "quote": {
      const idx = indexOfSlot(state.events, action.slot);
      if (idx < 0) return state;
      const events = state.events.slice();
      const updated: BlockEvent = { ...events[idx], quote: action.quote, quotes: [action.quote] };
      events[idx] = updated;
      return {
        ...state,
        events,
        latest: idx === events.length - 1 ? updated : state.latest,
      };
    }

    default:
      return state;
  }
}

function parseMeta(raw: Record<string, unknown> | null): Meta | null {
  if (!raw) return null;
  return {
    model: typeof raw.model === "string" ? raw.model : "",
    wallet: typeof raw.wallet === "string" ? raw.wallet : null,
    dryRun: Boolean(raw.dryRun),
    market: typeof raw.market === "string" ? raw.market : "SOL/USDC",
    venue: typeof raw.venue === "string" ? raw.venue : "multi",
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
  };
}

/**
 * Live slot feed over SSE.
 *
 * Connects to `${apiUrl}/events` and handles: `snapshot` (meta + history),
 * `block` (append, deduped by slot, capped at 1000), `quote`
 * ({ slot, quote } -> replaces that slot's quote once its receipt lands), `fill`
 * ({ slot, fill } -> a taker hit our resting order in that slot), `regime`
 * (regime gate snapshot, also fetched over GET /regime as a fallback) and
 * `ping` (liveness). Reconnects with 1s -> 10s backoff, surfacing `connection`.
 */
export function useFeed(apiUrl: string): FeedState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const base = (apiUrl || "").replace(/\/+$/, "");

    let closed = false;
    let attempt = 0;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let regimeTimer: ReturnType<typeof setInterval> | undefined;

    const fetchRegime = async () => {
      try {
        const r = await fetch(`${base}/regime`);
        if (!r.ok) return;
        const j: unknown = await r.json();
        if (!closed && isRegimeEvent(j)) dispatch({ type: "regime", regime: j });
      } catch {
        /* regime stays as-is; SSE events or the next refresh will pick it up */
      }
    };

    const armStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (!closed) scheduleReconnect();
      }, STALE_MS);
    };

    const teardown = () => {
      if (es) {
        es.onopen = null;
        es.onerror = null;
        es.close();
        es = null;
      }
      if (staleTimer) clearTimeout(staleTimer);
    };

    const scheduleReconnect = () => {
      if (closed) return;
      teardown();
      dispatch({ type: "connection", connection: "reconnecting" });
      const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt);
      attempt++;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    };

    const handle = (type: string, fn: (data: unknown) => void) => {
      es?.addEventListener(type, (raw: Event) => {
        armStaleTimer();
        const payload = (raw as MessageEvent).data;
        if (typeof payload !== "string" || !payload) return;
        let data: unknown;
        try {
          data = JSON.parse(payload);
        } catch {
          return;
        }
        fn(data);
      });
    };

    function connect() {
      if (closed) return;
      dispatch({ type: "connection", connection: attempt === 0 ? "connecting" : "reconnecting" });
      es = new EventSource(`${base}/events`);
      void fetchRegime();

      es.onopen = () => {
        attempt = 0;
        dispatch({ type: "connection", connection: "live" });
        armStaleTimer();
      };
      es.onerror = () => {
        if (!closed) scheduleReconnect();
      };

      handle("snapshot", (data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        const history = Array.isArray(d.history) ? (d.history as BlockEvent[]) : [];
        dispatch({ type: "snapshot", meta: parseMeta(d), history });
      });
      handle("block", (data) => {
        dispatch({ type: "block", event: data as BlockEvent });
      });
      handle("fill", (data) => {
        const d = (data ?? {}) as { slot?: number; fill?: Fill };
        if (typeof d.slot !== "number" || !d.fill) return;
        dispatch({ type: "fill", slot: d.slot, fill: d.fill });
      });
      handle("quote", (data) => {
        const d = (data ?? {}) as { slot?: number; quote?: Quote };
        if (typeof d.slot !== "number" || !d.quote) return;
        dispatch({ type: "quote", slot: d.slot, quote: d.quote });
      });
      handle("regime", (data) => {
        if (isRegimeEvent(data)) dispatch({ type: "regime", regime: data });
      });
      handle("ping", () => {
        dispatch({ type: "connection", connection: "live" });
      });
    }

    connect();
    regimeTimer = setInterval(fetchRegime, REGIME_REFRESH_MS);

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (regimeTimer) clearInterval(regimeTimer);
      teardown();
    };
  }, [apiUrl]);

  return state;
}

export default useFeed;
