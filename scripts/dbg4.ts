import { Connection } from "@solana/web3.js";
const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
for (const sig of ["3GUyGu7vSWcS","4E7pYMi9arZh","33ZXhwmXUfsU","1a1Su2Zi9GuC","5nSvjtZqwCsa"]) {
  const tx: any = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 10 });
  console.log(sig, tx ? new Date(tx.blockTime * 1000).toISOString() : "not found (prefix only)");
}
