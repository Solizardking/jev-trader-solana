import { Connection } from "@solana/web3.js";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const sig = "N3PWQH5J6PoW8V4GafZVVdaWeuoXBCRvRUg213YT2wTXxxHLScazFXBzwXoovquzkjcQMG4yQBKsU5fBcskCvU8";

const ptx: any = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
const logs: string[] = ptx.meta.logMessages;
// print only phoenix-attributed lines + program data lines with context
let inPhx = false;
for (const l of logs) {
  if (l.includes("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY")) inPhx = true;
  if (inPhx) console.log(l.slice(0, 120));
  if (inPhx && l.includes("success")) inPhx = false;
}
console.log("---all Program data lines---");
for (const l of logs) if (l.startsWith("Program data:")) console.log(l.slice(0, 100));
