import { config } from "./config";

/** Raw JSON-RPC call over HTTP. */
export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message} (${json.error.code})`);
  return json.result as T;
}

/**
 * Emits new slot numbers, coalesced to the newest one.
 * Solana slots land ~every 400 ms; we poll getSlot (no WS dependency) and
 * run the loop once per tick for the newest slot only — never for a stale one.
 */
export function startSlotFeed(onSlot: (slot: number) => void, pollMs = 200) {
  let last = 0, newest = 0, scheduled = false;
  const emit = (slot: number) => {
    if (slot <= last) return;
    last = newest = slot;
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; onSlot(newest); }, 0);
  };

  const poll = async () => {
    try { emit(await rpc<number>("getSlot", [{ commitment: "confirmed" }])); } catch {}
  };
  const timer = setInterval(poll, pollMs);
  poll();
  return () => clearInterval(timer);
}
