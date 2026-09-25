import { PublicKey } from "@solana/web3.js";
import { MarketState, getMarketUiLadder, type UiLadder } from "@ellipsis-labs/phoenix-sdk";
import { config } from "./config";
import { rpc } from "./chain";

export interface Book {
  slot: number;
  bid: number; // best bid, USDC per SOL
  ask: number; // best ask, USDC per SOL
  mid: number;
  spreadBps: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth) within 1% of mid. -1..1 */
  imbalance: number;
  /** Top 5 levels each side, best first: [price, size]. */
  levels: { bids: [number, number][]; asks: [number, number][] };
  /** Cumulative SOL depth within N bps of mid, per side. */
  depthBps: { [band: string]: { bid: number; ask: number } };
  /** Minimum price increment, USDC per SOL. */
  tickSize: number;
  /** Minimum size increment, SOL. */
  baseLotSize: number;
}

export interface MarketParams {
  state: MarketState;
  tickSize: number;
  baseLotSize: number;
  baseDecimals: number;
  quoteDecimals: number;
}

const MARKET_PK = new PublicKey(config.market);

/**
 * Max sane spread for a SOL-USDC spot book. Wider => the public book is a
 * fossil (orders that never trade, fictional mid) and the read fails closed
 * instead of quoting off fiction. Verified against the canonical Phoenix
 * SOL-USDC market (3084 bps, fossilized): a healthy book never looks like that.
 */
const MAX_SPREAD_BPS = Number(process.env.MAX_SPREAD_BPS ?? "50");

/** Load the market once; returns params + a book reader. Book refresh = one getAccountInfo per slot. */
export async function loadMarket(): Promise<{ params: MarketParams; readBook: (slot: number) => Promise<Book> }> {
  const info = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
    MARKET_PK.toBase58(),
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (!info.value?.data) throw new Error("market account not found");
  const buf = Buffer.from(info.value.data[0], "base64");
  const state = MarketState.load({ address: MARKET_PK, buffer: buf });
  const h: any = state.data.header;
  const baseDecimals = Number(h.baseParams.decimals);
  const quoteDecimals = Number(h.quoteParams.decimals);
  const tickSize = Number(h.tickSizeInQuoteAtomsPerBaseUnit.toString()) / 10 ** quoteDecimals;
  const baseLotSize = Number(h.baseLotSize.toString()) / 10 ** baseDecimals;
  const params: MarketParams = { state, tickSize, baseLotSize, baseDecimals, quoteDecimals };

  const readBook = async (slot: number): Promise<Book> => {
    const cur = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
      MARKET_PK.toBase58(),
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!cur.value?.data) throw new Error("market account not found");
    state.reload(Buffer.from(cur.value.data[0], "base64"));
    // slot + unixTimestamp are REQUIRED: they enable the expired-order filter.
    // The SDK defaults (0, 0) disable expiry filtering entirely.
    const unixTimestamp = Math.floor(Date.now() / 1000);
    const ladder: UiLadder = getMarketUiLadder(state, 32, slot, unixTimestamp);
    const bids = ladder.bids.map((l) => [l.price, l.quantity] as [number, number]);
    const asks = ladder.asks.map((l) => [l.price, l.quantity] as [number, number]);
    if (!bids.length || !asks.length) throw new Error("empty book");
    const bid = bids[0]![0], ask = asks[0]![0];
    if (!(bid > 0 && ask > bid)) throw new Error("crossed/invalid book");
    const mid = (bid + ask) / 2;
    const spreadBps = ((ask - bid) / mid) * 10_000;
    if (spreadBps > MAX_SPREAD_BPS)
      throw new Error(`book too wide: ${spreadBps.toFixed(1)} bps (fossil book, max ${MAX_SPREAD_BPS})`);
    const within = (levels: [number, number][], bps: number) =>
      levels.reduce((s, [p, q]) => s + (Math.abs(p - mid) / mid <= bps / 10_000 ? q : 0), 0);
    const bidDepth = within(bids, 100), askDepth = within(asks, 100);
    const imbalance = bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
    const depthBps: Book["depthBps"] = {};
    for (const band of [10, 25, 50]) depthBps[String(band)] = { bid: within(bids, band), ask: within(asks, band) };
    return {
      slot, bid, ask, mid, spreadBps, imbalance,
      levels: { bids: bids.slice(0, 5), asks: asks.slice(0, 5) },
      depthBps, tickSize, baseLotSize,
    };
  };

  return { params, readBook };
}
