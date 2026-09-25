import { Connection } from "@solana/web3.js";
import {
  getPhoenixEventsFromTransactionData,
  isPhoenixMarketEventFill,
  isPhoenixMarketEventFillSummary,
  toNum,
} from "@ellipsis-labs/phoenix-sdk";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const sigs = [
  "5L3mDmuz12GH7mKfzUYj3CPCuBVzf9zHh3X7krLegiyn2PpVrk4TAX3CoHWcZVyH5WMhEsx5XqZ3qg3yvqufjNTy",
  "N3PWQH5J6PoW8V4GafZVVdaWeuoXBCRvRUg213YT2wTXxxHLScazFXBzwXoovquzkjcQMG4yQBKsU5fBcskCvU8",
  "3LU8vExv4bhjiPhK4uPb5dSnsdic51cnJi6bWVL6RvNwwuhAoVxaMUNBu62DSbwRRYXWFv4huryri6VmEKhQDGCe",
];

const j = (v: any) => JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() : x);
for (const sig of sigs) {
  const ptx: any = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const phoenixTx = getPhoenixEventsFromTransactionData(ptx);
  console.log("===", sig.slice(0, 12));
  for (const ins of phoenixTx.instructions) {
    console.log("  ix disc:", ins.header.instruction, "signer:", ins.header.signer.toBase58().slice(0, 8));
    for (const ev of ins.events) {
      const kind = (ev as any).__kind;
      if (isPhoenixMarketEventFill(ev)) {
        const f = (ev as any).Fill;
        console.log("   FILL priceTicks=", toNum(f.priceInTicks), "baseLots=", toNum(f.baseLotsFilled));
      } else if (isPhoenixMarketEventFillSummary(ev)) {
        const s = (ev as any).FillSummary;
        console.log("   FILLSUMMARY baseLots=", toNum(s.totalBaseLotsFilled), "quoteLots=", toNum(s.totalQuoteLotsFilled), "clientOrderId=", toNum(s.clientOrderId));
      } else {
        console.log("   ", kind, j(ev).slice(0, 160));
      }
    }
  }
}
