import { decodePhoenixEvents, isPhoenixMarketEventFill } from "@ellipsis-labs/phoenix-sdk";
import { rpc } from "../src/chain";
const market = "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";
const sigs: any[] = await rpc("getSignaturesForAddress", [market, { limit: 40 }]);
let n = 0;
for (const s of sigs) {
  if (n >= 4) break;
  const tx: any = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1 }]);
  const logs: string[] = tx?.meta?.logMessages ?? [];
  const datas = logs.filter((l) => l.includes("Program data:")).map((l) => l.split("Program data:")[1].trim().split(" ")[0]);
  if (!datas.length) continue;
  n++;
  for (const d of datas) {
    try {
      const evts = decodePhoenixEvents(Buffer.from(d, "base64"));
      for (const e of evts) {
        if (isPhoenixMarketEventFill(e as any)) {
          const f: any = (e as any).Fill ?? (e as any).fill ?? Object.values((e as any))[0];
          const ticks = BigInt(f.priceInTicks?.toString() ?? "0");
          const lots = BigInt(f.baseLotsFilled?.toString() ?? "0");
          // price = ticks * tickSize(0.001 USDC); size = lots * 0.001 SOL
          console.log(s.signature.slice(0, 10), "fill @", (Number(ticks) * 0.001).toFixed(3), "size", (Number(lots) * 0.001).toFixed(4));
        }
      }
    } catch (err: any) { console.log("decode err", String(err?.message ?? err).slice(0, 60)); }
  }
}
console.log("done");
