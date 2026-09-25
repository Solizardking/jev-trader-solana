import { Connection, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  getPhoenixEventsFromTransactionData,
  isPhoenixMarketEventFill,
} from "@ellipsis-labs/phoenix-sdk";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const sig = "5L3mDmuz12GH7mKfzUYj3CPCuBVzf9zHh3X7krLegiyn2PpVrk4TAX3CoHWcZVyH5WMhEsx5XqZ3qg3yvqufjNTy";

const ptx: any = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
console.log("slot:", ptx.slot, "err:", ptx.meta.err);
console.log("logMessages:", JSON.stringify(ptx.meta.logMessages, null, 1).slice(0, 2000));

// raw phoenix instructions
const msg = ptx.transaction.message;
const keys = msg.accountKeys as { pubkey: PublicKey }[];
for (const ix of msg.instructions as any[]) {
  const pid: PublicKey | undefined = ix.programId ?? keys[ix.programIdIndex]?.pubkey;
  const isPhx = pid?.equals(PROGRAM_ID);
  console.log("ix program:", pid?.toBase58().slice(0, 12), "isPhoenix:", isPhx, "disc:", ix.data ? Buffer.from(require("bs58").decode(ix.data))[0] : ix.parsed?.type);
}

const phoenixTx = getPhoenixEventsFromTransactionData(ptx);
console.log("phoenix instructions:", phoenixTx.instructions.length, "txReceived:", phoenixTx.txReceived, "txFailed:", phoenixTx.txFailed);
for (const ins of phoenixTx.instructions) {
  console.log("  header.instruction:", ins.header.instruction, "totalEvents:", ins.header.totalEvents);
  for (const ev of ins.events) {
    const keys = Object.keys(ev);
    console.log("   event kind:", keys[0], isPhoenixMarketEventFill(ev) ? "(FILL)" : "");
    if (isPhoenixMarketEventFill(ev)) console.log("   fill:", JSON.stringify(ev, (k, v) => typeof v === "bigint" ? v.toString() : v?.toBase58?.() ?? v).slice(0, 300));
  }
}
