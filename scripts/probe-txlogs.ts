/** Dump full logMessages for one recent market tx. READ-ONLY. */
import { rpc } from "../src/chain";

const sig = process.argv[2] ?? "5L3mDmuz12GH7mKfzUYj3CPC";
const sigs: Array<{ signature: string }> = await rpc("getSignaturesForAddress", [
  process.env.MARKET ?? "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg",
  { limit: 12, commitment: "confirmed" },
]);
const full = sigs.find((s) => s.signature.startsWith(sig))?.signature ?? sigs[0].signature;
const tx: any = await rpc("getTransaction", [
  full,
  { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
]);
console.log("sig:", full);
for (const line of (tx.meta?.logMessages ?? []) as string[]) console.log("  " + line);
console.log("\ninner instructions:");
for (const g of (tx.meta?.innerInstructions ?? []) as any[]) {
  console.log(` group index=${g.index}:`);
  for (const ix of g.instructions) {
    const pid = typeof ix.programId === "string" ? ix.programId : ix.programId?.toBase58?.();
    console.log(`   program=${pid} data=${typeof ix.data === "string" ? ix.data.slice(0, 40) : "?"}...`);
  }
}
