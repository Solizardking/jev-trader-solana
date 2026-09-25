import { PublicKey } from "@solana/web3.js";
import { MarketState, getMarketUiLadder } from "@ellipsis-labs/phoenix-sdk";
import { rpc } from "../src/chain";
import { config } from "../src/config";

const info = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
  config.market, { encoding: "base64", commitment: "confirmed" },
]);
const buf = Buffer.from(info.value!.data[0], "base64");
const state = MarketState.load({ address: new PublicKey(config.market), buffer: buf });

// without slot/timestamp args
const ladder: any = getMarketUiLadder(state, 5);
console.log("bids:", JSON.stringify(ladder.bids.slice(0, 5)));
console.log("asks:", JSON.stringify(ladder.asks.slice(0, 5)));
