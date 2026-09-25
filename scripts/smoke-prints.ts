import { TradeFeed } from "../src/trades";

const feed = new TradeFeed({
  market: "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg",
  url: process.env.RPC_URL ?? "http://127.0.0.1:8899",
  tickSize: 0.001,
  baseLotSize: 0.001,
});

await feed.poll(450196404);
const prints = feed.drainPrints();
console.log(`decoded ${prints.length} prints`);
for (const p of prints.slice(0, 10)) {
  console.log(`slot=${p.slot} ${p.side} ${p.size} SOL @ ${p.price} tx=${p.txHash.slice(0, 12)}...`);
}
console.log("summary:", JSON.stringify(feed.summary(100000, 450196404)));
