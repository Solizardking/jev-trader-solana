import { Connection } from "@solana/web3.js";
import { getPhoenixEventsFromTransactionData, toNum } from "@ellipsis-labs/phoenix-sdk";
const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const ptx: any = await conn.getParsedTransaction("5L3mDmuz12GH7mKfzUYj3CPCuBVzf9zHh3X7krLegiyn2PpVrk4TAX3CoHWcZVyH5WMhEsx5XqZ3qg3yvqufjNTy", { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
const phoenixTx = getPhoenixEventsFromTransactionData(ptx);
for (const ins of phoenixTx.instructions) for (const ev of ins.events as any[]) {
  const f = ev.fields[0];
  if (ev.__kind === "Place") console.log("Place: priceTicks=", toNum(f.priceInTicks), "->", toNum(f.priceInTicks)*0.001, "lots=", toNum(f.baseLotsPlaced));
  if (ev.__kind === "FillSummary") console.log("FillSummary: base=", toNum(f.totalBaseLotsFilled), "quote=", toNum(f.totalQuoteLotsFilled));
}
