import { PublicKey } from "@solana/web3.js";
import { MarketState } from "@ellipsis-labs/phoenix-sdk";
import { rpc } from "../src/chain";
import { config } from "../src/config";

const info = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
  config.market, { encoding: "base64", commitment: "confirmed" },
]);
const buf = Buffer.from(info.value!.data[0], "base64");
const state = MarketState.load({ address: new PublicKey(config.market), buffer: buf });
const h: any = state.data.header;
console.log("baseMint:  ", h.baseParams.mintKey.toBase58());
console.log("quoteMint: ", h.quoteParams.mintKey.toBase58());
console.log("baseDecimals:", h.baseParams.decimals.toString(), "quoteDecimals:", h.quoteParams.decimals.toString());
console.log("tickSize raw:", h.tickSizeInQuoteAtomsPerBaseUnit.toString());
console.log("baseLotSize raw:", h.baseLotSize.toString());
// known mints
console.log("SOL mint:   So11111111111111111111111111111111111111112");
console.log("USDC mint:  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
