/**
 * HTTP + SSE server.
 *   GET /         snapshot (meta + latest block event)
 *   GET /history  recent slot events
 *   GET /regime   latest regime gate judgment
 *   GET /events   SSE stream: `snapshot`, `block`, `quote`, `fill`, `regime`, `ping`
 */
import { config } from "./config";
import type { Fill, Quote } from "./market";
import type { BlockEvent } from "./trader";
import { regimeEvent, type RegimeGate } from "./regime";

interface Meta {
  model: string;
  wallet: string | null;
  dryRun: boolean;
  market: string;
  /** Venue mode: "multi" = jupiter+dflow spot + imperial perps; "phoenix" = deprecated. */
  venue: string;
  startedAt: number;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

export function startServer(
  meta: Meta,
  history: () => BlockEvent[],
  latestRegime: () => RegimeGate | null,
) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try { c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); }
  };
  setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000);

  Bun.serve({
    port: config.port,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (pathname === "/") return json({ ...meta, latest: history().at(-1) ?? null });
      if (pathname === "/history") return json(history());
      if (pathname === "/regime") {
        const g = latestRegime();
        return g ? json(regimeEvent(g)) : json({ error: "no regime judgment yet" }, 503);
      }
      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            clients.add(c);
            send(c, "snapshot", { ...meta, history: history() });
            const g = latestRegime();
            if (g) send(c, "regime", regimeEvent(g));
          },
          cancel(c) { clients.delete(c); },
        });
        return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      return json({ error: "not found" }, 404);
    },
  });

  const broadcast = (type: string, data: unknown) => clients.forEach((c) => send(c, type, data));
  return {
    broadcast: (e: BlockEvent) => broadcast("block", e),
    /** A quote's receipt landed: placed (with order id) or reverted, and the real fee. Dry run: sim quotes only. */
    broadcastQuote: (slot: number, quote: Quote) => broadcast("quote", { slot, quote }),
    /** A taker hit one of our resting orders in `slot`. */
    broadcastFill: (slot: number, fill: Fill) => broadcast("fill", { slot, fill }),
    /** A fresh regime gate judgment (broadcast when it changes). */
    broadcastRegime: (g: RegimeGate) => broadcast("regime", regimeEvent(g)),
  };
}
