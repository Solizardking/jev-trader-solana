/** Probe: decode Phoenix events from the latest market tx; print fill prices. */
import { PublicKey } from "@solana/web3.js";
import { decodePhoenixEvents, isPhoenixMarketEventFill } from "@ellipsis-labs/phoenix-sdk";
import { rpc } from "../src/chain";

const market = "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";
const sigs: any[] = await rpc("getSignaturesForAddress", [market, { limit: 5 }]);
for (const s of sigs) {
  const tx: any = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
  if (!tx) continue;
  const logs: string[] = tx.meta?.logMessages ?? [];
  // Phoenix logs events via logAuthority; find program data logs
  for (const log of logs) {
    if (!log.includes("Program data:")) continue;
    const b64 = log.split("Program data:")[1].trim().split(" ")[0];
    try {
      const events = decodePhoenixEvents(Buffer.from(b64, "base64"));
      for (const e of events) {
        if (isPhoenixMarketEventFill(e as any)) {
          const f: any = (e as any).fields ?? e;
          const fill = f.fill ?? f[1] ?? f;
          console.log(s.signature.slice(0, 12), "FILL priceInTicks=", fill.priceInTicks?.toString(), "baseLotsFilled=", fill.baseLotsFilled?.toString());
        }
      }
    } catch {}
  }
}
console.log("done");
