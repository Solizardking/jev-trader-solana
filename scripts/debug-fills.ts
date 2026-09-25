import { Connection } from "@solana/web3.js";
import {
  getPhoenixEventsFromTransactionData,
  isPhoenixMarketEventFill,
  toNum,
} from "@ellipsis-labs/phoenix-sdk";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const sigs = [
  "5L3mDmuz12GH7mKfzUYj3CPCuBVzf9zHh3X7krLegiyn2PpVrk4TAX3CoHWcZVyH5WMhEsx5XqZ3qg3yvqufjNTy",
  "35LRRFXFmPD6is3kPLf1XHk4TepFZciUanTY9vcZniyCYUx8TbfLp7PeLhS9FpyQunnvzKV9xLU8KPxHZJFstDKm",
  "N3PWQH5J6PoW8V4GafZVVdaWeuoXBCRvRUg213YT2wTXxxHLScazFXBzwXoovquzkjcQMG4yQBKsU5fBcskCvU8",
  "3tBsgjuxBWpdB9d4nKdTn84S5V9e8ThEpi5fXhoD93tWmfpZvpXBYVCSejnKHMnLT8YQDg25nzL3ZbU1wezHHEbV",
  "3LU8vExv4bhjiPhK4uPb5dSnsdic51cnJi6bWVL6RvNwwuhAoVxaMUNBu62DSbwRRYXWFv4huryri6VmEKhQDGCe",
];

for (const sig of sigs) {
  const ptx: any = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!ptx || ptx.meta?.err) { console.log(sig.slice(0, 12), "no tx / failed"); continue; }
  const phoenixTx = getPhoenixEventsFromTransactionData(ptx);
  const kinds: string[] = [];
  const fills: string[] = [];
  for (const ins of phoenixTx.instructions) {
    for (const ev of ins.events) {
      const kind = (ev as any).__kind;
      kinds.push(kind);
      if (isPhoenixMarketEventFill(ev)) {
        const f = (ev as any).Fill;
        fills.push(`price=${toNum(f.priceInTicks) * 0.001} size=${toNum(f.baseLotsFilled) * 0.001}`);
      }
    }
  }
  console.log(sig.slice(0, 12), "slot", ptx.slot, "events:", kinds.join(","), fills.length ? "FILLS: " + fills.join(" | ") : "");
}
