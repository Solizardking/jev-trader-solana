/** Inspect what the recent market txs actually are: log programs, ix programIds. READ-ONLY. */
import { PublicKey } from "@solana/web3.js";
import { rpc } from "../src/chain";

const MARKET = process.env.MARKET ?? "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";
const PHOENIX = "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY";

const sigs: Array<{ signature: string; blockTime: number | null; slot: number }> = await rpc(
  "getSignaturesForAddress",
  [MARKET, { limit: 12, commitment: "confirmed" }]
);

for (const { signature, blockTime, slot } of sigs) {
  const tx: any = await rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  if (!tx) { console.log(signature.slice(0, 16), "NOT FOUND"); continue; }
  const err = tx.meta?.err ? "FAILED" : "ok";
  const programs = new Set<string>();
  const stack: string[] = [];
  let phoenixInvocations = 0;
  for (const line of (tx.meta?.logMessages ?? []) as string[]) {
    let m = line.match(/^Program (\S+) invoke \[\d+\]$/);
    if (m) { stack.push(m[1]); programs.add(m[1]); if (m[1] === PHOENIX) phoenixInvocations++; continue; }
    m = line.match(/^Program (\S+) (success|failed)$/);
    if (m) { const i = stack.lastIndexOf(m[1]); if (i >= 0) stack.splice(i); }
  }
  // top-level ix programIds (jsonParsed)
  const top: string[] = (tx.transaction?.message?.instructions ?? []).map((ix: any) =>
    typeof ix.programId === "string" ? ix.programId : ix.programId?.toBase58?.() ?? "?"
  );
  const innerGroups = tx.meta?.innerInstructions ?? [];
  console.log(
    `${new Date((blockTime ?? 0) * 1000).toISOString()} slot=${slot} ${err} phoenixInvokes=${phoenixInvocations}`
  );
  console.log(`  sig=${signature.slice(0, 24)}...`);
  console.log(`  top-level programs: ${top.join(", ")}`);
  console.log(`  all invoked programs: ${[...programs].map((p) => (p === PHOENIX ? "PHOENIX" : p.slice(0, 10))).join(", ")}`);
  console.log(`  innerIx groups: ${innerGroups.length}`);
}
