import { Connection, PublicKey } from "@solana/web3.js";
import {
  getPhoenixEventsFromTransactionData,
  isPhoenixMarketEventFill,
  isPhoenixMarketEventFillSummary,
  toNum,
} from "@ellipsis-labs/phoenix-sdk";
import { config } from "../src/config";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const sigs = await conn.getSignaturesForAddress(new PublicKey(config.market), { limit: 100, commitment: "confirmed" } as any);
console.log("signatures:", sigs.length);
let withFills = 0, fillEvents = 0, summaryEvents = 0;
const examples: string[] = [];
for (const s of sigs) {
  if (s.err) continue;
  const ptx: any = await conn.getParsedTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 10 });
  if (!ptx || ptx.meta?.err) continue;
  let got = false;
  for (const ins of getPhoenixEventsFromTransactionData(ptx).instructions) {
    for (const ev of ins.events as any[]) {
      const f = ev.fields?.[0];
      if (isPhoenixMarketEventFill(ev)) {
        fillEvents++; got = true;
        if (examples.length < 8) examples.push(`${s.signature.slice(0,12)} t=${s.blockTime ? new Date(s.blockTime*1000).toISOString().slice(5,16) : "?"} FILL px=${toNum(f.priceInTicks)*0.001} base=${toNum(f.baseLotsFilled)*0.001}`);
      }
      if (isPhoenixMarketEventFillSummary(ev)) {
        summaryEvents++;
        const b = toNum(f.totalBaseLotsFilled);
        if (b > 0) {
          got = true;
          if (examples.length < 8) examples.push(`${s.signature.slice(0,12)} t=${s.blockTime ? new Date(s.blockTime*1000).toISOString().slice(5,16) : "?"} base=${b*0.001} avgPx=${(toNum(f.totalQuoteLotsFilled)/b*0.001).toFixed(3)}`);
        }
      }
    }
  }
  if (got) withFills++;
}
console.log({ withFills, fillEvents, summaryEvents });
console.log("examples:", examples);
