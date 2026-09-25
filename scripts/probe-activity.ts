import { rpc } from "../src/chain";
const market = "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";
const sigs: any[] = await rpc("getSignaturesForAddress", [market, { limit: 40 }]);
let withData = 0, checked = 0;
for (const s of sigs) {
  const tx: any = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1 }]);
  if (!tx) continue;
  checked++;
  const logs: string[] = tx.meta?.logMessages ?? [];
  if (logs.some((l) => l.includes("Program data:"))) withData++;
}
console.log(`checked ${checked} txs, ${withData} with Program data logs (trades/fills)`);
