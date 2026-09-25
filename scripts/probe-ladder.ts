/** Probe: does passing slot/unixTimestamp tighten the ladder (expired-order filtering)? */
import { PublicKey } from "@solana/web3.js";
import { MarketState, getMarketUiLadder } from "@ellipsis-labs/phoenix-sdk";
import { rpc } from "../src/chain";

const addr = new PublicKey("4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg");
const info: any = await rpc("getAccountInfo", [addr.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
const state = MarketState.load({ address: addr, buffer: Buffer.from(info.value.data[0], "base64") });
const slot: number = await rpc("getSlot", [{ commitment: "confirmed" }]);
const block: any = await rpc("getBlock", [slot - 5, { maxSupportedTransactionVersion: 0, rewards: false, transactionDetails: "none" }]).catch(() => null);
const ts = block?.blockTime ?? Math.floor(Date.now() / 1000);

for (const [label, args] of [
  ["no slot/ts", []],
  ["with slot/ts", [slot, ts]],
] as const) {
  const l = getMarketUiLadder(state, 16, ...(args as []));
  const b = l.bids[0], a = l.asks[0];
  console.log(label, `slot=${slot} ts=${ts}`);
  console.log(`  bid ${b?.price} x${b?.quantity} | ask ${a?.price} x${a?.quantity} | spreadBps ${(((a.price - b.price) / ((a.price + b.price) / 2)) * 1e4).toFixed(1)}`);
  console.log("  bids:", l.bids.slice(0, 4).map((x) => `${x.price.toFixed(2)}x${x.quantity.toFixed(3)}`).join(" "));
  console.log("  asks:", l.asks.slice(0, 4).map((x) => `${x.price.toFixed(2)}x${x.quantity.toFixed(3)}`).join(" "));
}
