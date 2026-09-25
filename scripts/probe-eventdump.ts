/** Dump all Phoenix events (Place/Fill/Reduce/FillSummary) for the N most recent market txs with UI prices. READ-ONLY. */
import { PublicKey } from "@solana/web3.js";
import {
  MarketState,
  getPhoenixEventsFromTransactionData,
  toNum,
} from "@ellipsis-labs/phoenix-sdk";
import { rpc } from "../src/chain";

const MARKET = new PublicKey(process.env.MARKET ?? "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg");
const info: any = await rpc("getAccountInfo", [MARKET.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
const state = MarketState.load({ address: MARKET, buffer: Buffer.from(info.value.data[0], "base64") });

const N = Number(process.env.N ?? "12");
const sigs: Array<{ signature: string; blockTime: number | null }> = await rpc(
  "getSignaturesForAddress",
  [MARKET.toBase58(), { limit: N, commitment: "confirmed" }]
);

for (const { signature, blockTime } of sigs) {
  const tx: any = await rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  if (!tx || tx.meta?.err) continue;
  for (const g of (tx.meta?.innerInstructions ?? []) as any[]) {
    for (const ix of g.instructions ?? []) {
      if (typeof ix.programId === "string") ix.programId = new PublicKey(ix.programId);
    }
  }
  const parsed = getPhoenixEventsFromTransactionData(tx as any);
  if (!parsed.instructions.length) continue;
  console.log(`\n${new Date((blockTime ?? 0) * 1000).toISOString()} ${signature.slice(0, 20)}...`);
  for (const { header, events } of parsed.instructions) {
    console.log(`  header: ix=${header.instruction} seq=${header.sequenceNumber} slot=${header.slot} signer=${header.signer.toBase58().slice(0, 10)}`);
    for (const ev of events) {
      const kind = (ev as any).__kind;
      const f: any = (ev as any).fields?.[0] ?? {};
      if (kind === "Place") {
        const px = state.ticksToFloatPrice(Number(toNum(f.priceInTicks)));
        const sz = state.baseLotsToRawBaseUnits(Number(toNum(f.baseLotsPlaced ?? 0)));
        console.log(`    Place side=${f.side} price=${px.toFixed(3)} size=${sz.toFixed(4)} maker=${f.makerId?.toBase58?.().slice(0, 8)}`);
      } else if (kind === "Fill") {
        const px = state.ticksToFloatPrice(Number(toNum(f.priceInTicks)));
        const sz = state.baseLotsToRawBaseUnits(Number(toNum(f.baseLotsFilled)));
        console.log(`    Fill price=${px.toFixed(3)} size=${sz.toFixed(4)} maker=${f.makerId?.toBase58?.().slice(0, 8)}`);
      } else if (kind === "FillSummary") {
        console.log(`    FillSummary totalBaseLots=${f.totalBaseLotsFilled.toString()} totalQuoteLots=${f.totalQuoteLotsFilled.toString()}`);
      } else if (kind === "Reduce") {
        console.log(`    Reduce`);
      } else {
        console.log(`    ${kind}`);
      }
    }
  }
}
