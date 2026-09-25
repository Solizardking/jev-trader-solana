import { Connection } from "@solana/web3.js";
import { getPhoenixEventsFromTransactionData } from "@ellipsis-labs/phoenix-sdk";
const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const ptx: any = await conn.getParsedTransaction("5L3mDmuz12GH7mKfzUYj3CPCuBVzf9zHh3X7krLegiyn2PpVrk4TAX3CoHWcZVyH5WMhEsx5XqZ3qg3yvqufjNTy", { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
const phoenixTx = getPhoenixEventsFromTransactionData(ptx);
for (const ins of phoenixTx.instructions) for (const ev of ins.events) {
  console.log(JSON.stringify(ev, (k, x) => typeof x === "bigint" ? "BIG:"+x.toString() : (x && x.toBase58 ? "PK:"+x.toBase58().slice(0,8) : x), 1).slice(0, 800));
  console.log("----");
}
