import { getPhoenixEventsFromTransactionData, isPhoenixMarketEventFill, isPhoenixMarketEventFillSummary } from "@ellipsis-labs/phoenix-sdk";
import { rpc } from "../src/chain";
const market = "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";
const sigs: any[] = await rpc("getSignaturesForAddress", [market, { limit: 10 }]);
for (const s of sigs) {
  const tx: any = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  if (!tx) continue;
  try {
    const evts: any[] = getPhoenixEventsFromTransactionData(tx);
    for (const e of evts) {
      const v: any = (e as any).fields ? Object.values((e as any).fields)[0] : e;
      if (isPhoenixMarketEventFill(e as any) || isPhoenixMarketEventFillSummary(e as any)) {
        console.log(s.signature.slice(0, 10), JSON.stringify(v).slice(0, 220));
      }
    }
    if (evts.length) console.log(s.signature.slice(0, 10), "nEvents:", evts.length);
  } catch (err: any) { console.log(s.signature.slice(0, 10), "err", String(err?.message ?? err).slice(0, 60)); }
}
console.log("done");
