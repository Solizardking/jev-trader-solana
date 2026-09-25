/** TRUE Phoenix fills for the market, decoded the SDK-canonical way: from the inner
 *  Log instruction's DATA (getPhoenixEventsFromTransactionData), plus a log-framing
 *  attribution audit showing why raw "Program data:" scraping fails. READ-ONLY. */
import { PublicKey } from "@solana/web3.js";
import {
  MarketState,
  getPhoenixEventsFromTransactionData,
  isPhoenixMarketEventFill,
  isPhoenixMarketEventPlace,
  toNum,
} from "@ellipsis-labs/phoenix-sdk";
import bs58 from "bs58";
import { rpc } from "../src/chain";

const MARKET = new PublicKey(process.env.MARKET ?? "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg");
const PHOENIX = "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY";
const LIMIT = Number(process.env.FILL_LIMIT ?? "40");

const info: any = await rpc("getAccountInfo", [MARKET.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
const state = MarketState.load({ address: MARKET, buffer: Buffer.from(info.value.data[0], "base64") });

const sigs: Array<{ signature: string; blockTime: number | null }> = await rpc(
  "getSignaturesForAddress",
  [MARKET.toBase58(), { limit: LIMIT, commitment: "confirmed" }]
);
console.log(`fetched ${sigs.length} signatures for market`);

type Fill = { sig: string; time: string; takerSide: string; price: number; sizeSol: number };
const fills: Fill[] = [];
const eventTypes = new Map<string, number>();
let decodedTxs = 0, failedTxs = 0, notFound = 0;
const attribution = { phoenixDataLines: 0, otherProgramsDataLines: 0 };

for (const { signature, blockTime } of sigs) {
  const tx: any = await rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  if (!tx) { notFound++; continue; }
  if (tx.meta?.err) { failedTxs++; continue; }

  // --- log-framing audit: who emits "Program data:" lines? ---
  const stack: string[] = [];
  for (const line of (tx.meta?.logMessages ?? []) as string[]) {
    let m = line.match(/^Program (\S+) invoke \[(\d+)\]$/);
    if (m) { stack.push(m[1]); continue; }
    m = line.match(/^Program (\S+) (success|failed)$/);
    if (m) { const i = stack.lastIndexOf(m[1]); if (i >= 0) stack.splice(i); continue; }
    m = line.match(/^Program data: (\S+)$/);
    if (m) {
      if (stack[stack.length - 1] === PHOENIX) attribution.phoenixDataLines++;
      else attribution.otherProgramsDataLines++;
    }
  }

  // --- canonical SDK decode from inner Log instruction data ---
  // (SDK expects web3.js PublicKey objects for programId, not plain strings)
  for (const g of (tx.meta?.innerInstructions ?? []) as any[]) {
    for (const ix of g.instructions ?? []) {
      if (typeof ix.programId === "string") ix.programId = new PublicKey(ix.programId);
    }
  }
  const parsed = getPhoenixEventsFromTransactionData(tx as any);
  if (parsed.instructions.length === 0) continue;
  decodedTxs++;

  // taker side from the top-level Phoenix swap ix order packet
  let takerSide = "unknown";
  const topIxs: any[] = tx.transaction?.message?.instructions ?? [];
  for (const ix of topIxs) {
    const pid = typeof ix.programId === "string" ? ix.programId : ix.programId?.toBase58?.();
    if (pid === PHOENIX && typeof ix.data === "string") {
      try {
        const raw = bs58.decode(ix.data);
        if (raw[0] === 0 && raw[1] === 2) takerSide = raw[2] === 0 ? "BUY" : raw[2] === 1 ? "SELL" : "unknown";
        else if (raw[0] === 2) takerSide = "LIMIT(as-taker)";
      } catch {}
    }
  }

  for (const { events } of parsed.instructions) {
    for (const ev of events) {
      const kind = (ev as any).__kind ?? "?";
      eventTypes.set(kind, (eventTypes.get(kind) ?? 0) + 1);
      if (isPhoenixMarketEventFill(ev)) {
        const f: any = (ev as any).fields?.[0];
        fills.push({
          sig: signature,
          time: blockTime ? new Date(blockTime * 1000).toISOString() : "?",
          takerSide,
          price: state.ticksToFloatPrice(Number(toNum(f.priceInTicks))),
          sizeSol: state.baseLotsToRawBaseUnits(Number(toNum(f.baseLotsFilled))),
        });
      }
    }
  }
}

console.log(`\ntxs: ${sigs.length} | notFound=${notFound} failed=${failedTxs} | with Phoenix events=${decodedTxs}`);
console.log("log-framing audit: phoenix-attributed 'Program data:' lines =", attribution.phoenixDataLines,
  "| other programs' =", attribution.otherProgramsDataLines);
console.log("event types seen:", JSON.stringify(Object.fromEntries(eventTypes)));
console.log(`\nFILLS (${fills.length}):`);
for (const f of fills) {
  console.log(`${f.time} taker=${f.takerSide} price=${f.price.toFixed(3)} size=${f.sizeSol.toFixed(4)} SOL sig=${f.sig}`);
}
