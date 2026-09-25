import { rpc } from "../src/chain";
const market = "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";
const sigs: any[] = await rpc("getSignaturesForAddress", [market, { limit: 2 }]);
const tx: any = await rpc("getTransaction", [sigs[0].signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
console.log("sig:", sigs[0].signature);
for (const log of (tx.meta?.logMessages ?? []) as string[]) {
  if (log.includes("PhoeNi") || log.includes("Program data") || log.includes("Fill") || log.includes("invoke"))
    console.log(log.slice(0, 160));
}
