/** Extract TRUE Phoenix Fill events for the market: attribute "Program data:" logs to
 *  the Phoenix program only via the invoke/success log framing, then decode with
 *  the SDK's getPhoenixEventsFromLogData. READ-ONLY. */
import { PublicKey } from "@solana/web3.js";
import {
  MarketState,
  getPhoenixEventsFromLogData,
  logInstructionDiscriminator,
  isPhoenixMarketEventFill,
  toNum,
} from "@ellipsis-labs/phoenix-sdk";
import bs58 from "bs58";
import { rpc } from "../src/chain";

const MARKET = new PublicKey(process.env.MARKET ?? "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg");
const PHOENIX = "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY";
const LIMIT = Number(process.env.FILL_LIMIT ?? "40");

// Market for price conversion
const info: any = await rpc("getAccountInfo", [MARKET.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
const state = MarketState.load({ address: MARKET, buffer: Buffer.from(info.value.data[0], "base64") });

const sigs: Array<{ signature: string; blockTime: number | null }> = await rpc(
  "getSignaturesForAddress",
  [MARKET.toBase58(), { limit: LIMIT, commitment: "confirmed" }]
);
console.log(`fetched ${sigs.length} signatures for market`);

type Fill = { sig: string; time: string; takerSide: string; price: number; sizeSol: number; makerShort: string };
const fills: Fill[] = [];
const eventTypes = new Map<string, number>();
const skipped: string[] = [];
let phoenixTxs = 0, failedTxs = 0;

for (const { signature, blockTime } of sigs) {
  const tx: any = await rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  if (!tx) { skipped.push(signature + " (not found)"); continue; }
  if (tx.meta?.err) { failedTxs++; continue; }

  const logs: string[] = tx.meta?.logMessages ?? [];
  // --- attribute Program data: lines to the innermost invoking program ---
  const stack: string[] = [];
  const phoenixDataLines: string[] = [];
  for (const line of logs) {
    let m = line.match(/^Program (\S+) invoke \[(\d+)\]$/);
    if (m) { stack.push(m[1]); continue; }
    m = line.match(/^Program (\S+) (success|failed)$/);
    if (m) { const i = stack.lastIndexOf(m[1]); if (i >= 0) stack.splice(i); continue; }
    m = line.match(/^Program data: (\S+)$/);
    if (m && stack[stack.length - 1] === PHOENIX) phoenixDataLines.push(m[1]);
  }
  if (phoenixDataLines.length === 0) continue;
  phoenixTxs++;

  // Taker side: decode Phoenix swap ix order packet (swap disc=0, IOC tag=2, side byte: 0=Bid(buy base))
  let takerSide = "unknown";
  const walk = (ixs: any[]) => {
    for (const ix of ixs ?? []) {
      const pid = typeof ix.programId === "string" ? ix.programId : ix.programId?.toBase58?.();
      if (pid === PHOENIX && typeof ix.data === "string") {
        try {
          const raw = bs58.decode(ix.data);
          if (raw[0] === 0 && raw[1] === 2) takerSide = raw[2] === 0 ? "BUY" : raw[2] === 1 ? "SELL" : "unknown";
        } catch {}
      }
      walk(ix.innerInstructions ?? []);
    }
  };
  walk(tx.transaction?.message?.instructions ?? []);
  walk((tx.meta?.innerInstructions ?? []).flatMap((g: any) => g.instructions ?? []));

  // Decode each phoenix-attributed Program data line with the SDK decoder
  for (const b58 of phoenixDataLines) {
    const raw = Buffer.from(bs58.decode(b58));
    if (raw[0] !== logInstructionDiscriminator) {
      eventTypes.set("non-log-instruction-data", (eventTypes.get("non-log-instruction-data") ?? 0) + 1);
      continue;
    }
    try {
      const { events } = getPhoenixEventsFromLogData(raw.subarray(1));
      for (const ev of events) {
        const kind = (ev as any).__kind ?? Object.keys(ev as any).find((k) => k !== "__kind") ?? "?";
        eventTypes.set(kind, (eventTypes.get(kind) ?? 0) + 1);
        if (isPhoenixMarketEventFill(ev as any)) {
          const f: any = (ev as any).Fill ?? (ev as any).fields?.[0] ?? ev;
          const price = state.ticksToFloatPrice(Number(toNum(f.priceInTicks)));
          const sizeSol = state.baseLotsToRawBaseUnits(Number(toNum(f.baseLotsFilled)));
          fills.push({
            sig: signature,
            time: blockTime ? new Date(blockTime * 1000).toISOString() : "?",
            takerSide,
            price,
            sizeSol,
            makerShort: f.makerId?.toBase58?.().slice(0, 8) ?? "?",
          });
        }
      }
    } catch {
      eventTypes.set("decode-error", (eventTypes.get("decode-error") ?? 0) + 1);
    }
  }
}

console.log(`\ntxs with phoenix-attributed Program data: ${phoenixTxs} | failed txs: ${failedTxs} | skipped: ${skipped.length}`);
console.log("event types seen:", JSON.stringify(Object.fromEntries(eventTypes)));
console.log(`\nFILLS (${fills.length}):`);
for (const f of fills.slice(0, 30)) {
  console.log(`${f.time} taker=${f.takerSide} price=${f.price.toFixed(3)} size=${f.sizeSol.toFixed(4)} SOL maker=${f.makerShort} sig=${f.sig.slice(0, 20)}...`);
}
