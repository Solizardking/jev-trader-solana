import { rpc } from "../src/chain";
const market = "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";
const sigs: any[] = await rpc("getSignaturesForAddress", [market, { limit: 40 }]);
let n = 0;
for (const s of sigs) {
  if (n >= 3) break;
  const tx: any = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1 }]);
  const logs: string[] = tx?.meta?.logMessages ?? [];
  const idx = logs.findIndex((l) => l.includes("Program data:"));
  if (idx < 0) continue;
  n++;
  console.log("sig:", s.signature.slice(0, 16));
  for (let i = Math.max(0, idx - 3); i < Math.min(logs.length, idx + 2); i++) console.log("   ", logs[i].slice(0, 110));
}
