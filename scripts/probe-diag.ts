/** Diagnose the wide ladder on the target Phoenix market. READ-ONLY. */
import { PublicKey } from "@solana/web3.js";
import {
  MarketState,
  MarketStatus,
  getMarketUiLadder,
  getUiOrderSequenceNumber,
  toNum,
} from "@ellipsis-labs/phoenix-sdk";
import { rpc } from "../src/chain";

const MARKET = new PublicKey(process.env.MARKET ?? "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg");
const PHOENIX = "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY";

const info: any = await rpc("getAccountInfo", [MARKET.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
const state = MarketState.load({ address: MARKET, buffer: Buffer.from(info.value.data[0], "base64") });
const h: any = state.data.header;
const d: any = state.data;

console.log("market:", MARKET.toBase58());
console.log("owner:", info.value.owner, "(phoenix expected:", PHOENIX + ")");
console.log("baseMint:", h.baseParams.mintKey.toBase58(), "decimals:", h.baseParams.decimals.toString());
console.log("quoteMint:", h.quoteParams.mintKey.toBase58(), "decimals:", h.quoteParams.decimals.toString());
console.log("status:", MarketStatus[Number(h.status.toString())] ?? h.status.toString());
console.log("tickSize USDC/SOL:", Number(h.tickSizeInQuoteAtomsPerBaseUnit.toString()) / 10 ** Number(h.quoteParams.decimals));
console.log("baseLotSize SOL:", Number(h.baseLotSize.toString()) / 10 ** Number(h.baseParams.decimals));
console.log("takerFeeBps:", d.takerFeeBps, "| orderSequenceNumber:", d.orderSequenceNumber);
console.log("bids tree size:", d.bids.length, "| asks tree size:", d.asks.length);

const slot: number = await rpc("getSlot", [{ commitment: "confirmed" }]);
const blk: any = await rpc("getBlock", [slot - 5, { maxSupportedTransactionVersion: 0, rewards: false, transactionDetails: "none" }]).catch(() => null);
const ts: number = blk?.blockTime ?? Math.floor(Date.now() / 1000);
console.log("slot:", slot, "blockTime:", ts, new Date(ts * 1000).toISOString());

// Expiry accounting on raw tree entries
const expired = (arr: any[]) => {
  let bySlot = 0, byTs = 0, live = 0;
  for (const [, ro] of arr) {
    const lvs = Number(ro.lastValidSlot?.toString() ?? "0");
    const lvt = Number(ro.lastValidUnixTimestampInSeconds?.toString() ?? "0");
    if (lvs !== 0 && lvs < slot) bySlot++;
    else if (lvt !== 0 && lvt < ts) byTs++;
    else live++;
  }
  return { bySlot, byTs, live };
};
console.log("bids expiry:", JSON.stringify(expired(d.bids)), "| asks expiry:", JSON.stringify(expired(d.asks)));

// Top 10 levels with slot-filtered ladder
const ladder = getMarketUiLadder(state, 10, slot, ts);
console.log("\n--- UI ladder (levels=10, slot/ts filtered) ---");
console.log("BIDS (price x qty SOL):");
ladder.bids.forEach((l, i) => console.log(`  ${i + 1}. ${l.price.toFixed(3)} x ${l.quantity.toFixed(4)}`));
console.log("ASKS (price x qty SOL):");
ladder.asks.forEach((l, i) => console.log(`  ${i + 1}. ${l.price.toFixed(3)} x ${l.quantity.toFixed(4)}`));
const b0 = ladder.bids[0], a0 = ladder.asks[0];
if (b0 && a0) console.log("spreadBps:", (((a0.price - b0.price) / ((a0.price + b0.price) / 2)) * 1e4).toFixed(1));

// Raw top-of-book entries: order age info to spot stale resting orders
console.log("\n--- raw top bids (orderId -> resting order fields) ---");
for (const [oid, ro] of d.bids.slice(0, 5)) {
  console.log(
    `priceTicks=${toNum(oid.priceInTicks)} seq=${getUiOrderSequenceNumber(oid).toString()} ` +
    `lots=${toNum(ro.numBaseLots)} lastValidSlot=${ro.lastValidSlot.toString()} ` +
    `lastValidTs=${ro.lastValidUnixTimestampInSeconds.toString()}`
  );
}
console.log("--- raw top asks ---");
for (const [oid, ro] of d.asks.slice(0, 5)) {
  console.log(
    `priceTicks=${toNum(oid.priceInTicks)} seq=${getUiOrderSequenceNumber(oid).toString()} ` +
    `lots=${toNum(ro.numBaseLots)} lastValidSlot=${ro.lastValidSlot.toString()} ` +
    `lastValidTs=${ro.lastValidUnixTimestampInSeconds.toString()}`
  );
}
