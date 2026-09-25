/**
 * Taker prints for the Phoenix SOL-USDC book.
 *
 * Verified decode path (per the 2026-09-25 market-data diagnosis, 40-tx
 * probe against this market):
 * - Phoenix emits events in the **inner instruction data** of its Log CPI
 *   (discriminator 15). It emits ZERO `Program data:` log lines, so log
 *   scraping misattributes other programs' logs — never use it.
 * - `getPhoenixEventsFromTransactionData` over a parsed transaction handles
 *   log attribution. Event shape: `{ __kind: "Fill", fields: [{ index,
 *   makerId, orderSequenceNumber, priceInTicks, baseLotsFilled,
 *   baseLotsRemaining }] }` — note `fields[0]`, not `.Fill`.
 * - Fill events carry **no taker side**. Attribute it from the originating
 *   top-level instruction's data:
 *     - Swap (disc 0): `data[1] == 2` (ImmediateOrCancel order packet),
 *       side byte `data[2]`: 0 = Bid = taker **buys** base, 1 = Ask = taker
 *       sells base. Any other packet tag => no taker print expected, skip.
 *     - PlaceLimitOrder (disc 2): the order crossed the spread immediately,
 *       so taker side = the order packet's side (beet struct decode).
 * - `getParsedTransaction` needs `maxSupportedTransactionVersion: 1`
 *   (versioned txs are common here; 0 fails on them).
 *
 * Polling: `getSignaturesForAddress` every ~8s with a `before` cursor
 * (deduped on signature). This market prints ~7 fills per 2 days, so a
 * taker-print feed cannot drive per-slot simulated fills — it is a
 * supplementary signal only.
 *
 * The FIRST poll only establishes the cursor: historical signatures are
 * marked seen and never decoded, so no stale fills replay into the feed.
 *
 * Dry run: there is no wallet, so drainFills() is always empty — maker fills
 * are simulated by the trader against these prints.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  PROGRAM_ID,
  getPhoenixEventsFromTransactionData,
  isPhoenixMarketEventFill,
  logInstructionDiscriminator,
  placeLimitOrderInstructionDiscriminator,
  swapInstructionDiscriminator,
  PlaceLimitOrderStruct,
  toNum,
} from "@ellipsis-labs/phoenix-sdk";
import { config } from "./config";

export interface TradePrint { slot: number; price: number; size: number; side: "buy" | "sell"; txHash: string }

export interface TradeSummary {
  count: number;
  buySol: number;
  sellSol: number;
  /** taker buy volume minus taker sell volume (SOL) */
  cvdSol: number;
  vwap: number | null;
  lastPrice: number | null;
  lastSide: "buy" | "sell" | null;
}

const RING = 2000;
const SIG_LIMIT = 30;
/** Swap order-packet tag for ImmediateOrCancel — the only Swap packet that prints as a taker. */
const IOC_PACKET_TAG = 2;

export class TradeFeed {
  private readonly conn: Connection;
  private readonly market: PublicKey;
  private readonly tickSize: number;
  private readonly baseLotSize: number;
  private readonly everySlots: number;
  private trades: TradePrint[] = [];
  private fresh: TradePrint[] = []; // appended since the last drainPrints()
  private seen = new Set<string>();
  private cursor: string | null = null; // newest signature already processed
  private lastPollSlot = -1;
  private inFlight = false;
  private warmed = false;

  constructor(opts: { market: string; url: string; tickSize: number; baseLotSize: number; everySlots?: number }) {
    this.conn = new Connection(opts.url, "confirmed");
    this.market = new PublicKey(opts.market);
    this.tickSize = opts.tickSize;
    this.baseLotSize = opts.baseLotSize;
    // ~8s at 400ms/slot. This market averages ~20 sigs/day; faster polling buys nothing.
    this.everySlots = opts.everySlots ?? Number(process.env.PRINTS_EVERY_SLOTS ?? "20");
  }

  /**
   * Fetch new market signatures and decode their Fill events. Throttled to
   * one run per `everySlots`; never throws; drops the call if one is in
   * flight (the next slot retries). The first poll only warms the cursor —
   * no historical fills are replayed.
   */
  async poll(slot: number): Promise<void> {
    if (this.inFlight || slot - this.lastPollSlot < this.everySlots) return;
    this.inFlight = true;
    this.lastPollSlot = slot;
    try {
      const sigs = await this.conn.getSignaturesForAddress(
        this.market,
        this.cursor ? { limit: SIG_LIMIT, before: this.cursor } : { limit: SIG_LIMIT },
      );
      if (!this.warmed) {
        // Cursor establishment: remember everything, decode nothing.
        for (const s of sigs) this.seen.add(s.signature);
        if (sigs.length) this.cursor = sigs[0]!.signature;
        this.warmed = true;
        return;
      }
      // RPC returns newest first; decode oldest first so prints stay ordered.
      const fresh = sigs.filter((s) => !this.seen.has(s.signature)).reverse();
      for (const s of fresh) this.seen.add(s.signature);
      if (sigs.length) this.cursor = sigs[0]!.signature;
      if (this.seen.size > 5000) {
        const drop = [...this.seen].slice(0, this.seen.size - 5000);
        for (const d of drop) this.seen.delete(d);
      }
      for (const s of fresh) {
        try {
          const prints = await this.printsForSignature(s.signature);
          for (const p of prints) { this.trades.push(p); this.fresh.push(p); }
        } catch { /* one bad tx never breaks the feed */ }
      }
      if (this.trades.length > RING) this.trades.splice(0, this.trades.length - RING);
    } catch (e) {
      console.error("[prints]", (e as Error).message);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Decode one transaction's Phoenix Fill events into taker prints.
   * Public so the validation script can check it against known fills.
   */
  async printsForSignature(signature: string): Promise<TradePrint[]> {
    const ptx = await this.conn.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    if (!ptx || ptx.meta?.err) return [];
    const slot = ptx.slot;

    // Phoenix origin instructions in execution order: top-level first, then
    // each top-level ix's inner ixs. A Swap often arrives via CPI (e.g. a
    // Jupiter router), so inner instructions MUST be scanned — the Log ix
    // (discriminator 15) is excluded since it carries events, not intent.
    // Verified: a Jupiter-routed Swap on this market appears as inner data
    // [0, 2, 1] (Swap / IOC / Ask).
    const originIxs: { discriminator: number; data: Buffer }[] = [];
    const msg = ptx.transaction.message;
    const accountKeys = "accountKeys" in msg ? (msg as any).accountKeys as { pubkey: PublicKey }[] : [];
    const programIdOf = (ix: any): PublicKey | undefined =>
      ix.programId ?? (typeof ix.programIdIndex === "number" ? accountKeys[ix.programIdIndex]?.pubkey : undefined);
    const dataOf = (ix: any): Buffer | null => {
      if (typeof ix.data !== "string") return null;
      const data = Buffer.from(bs58.decode(ix.data));
      return data.length ? data : null;
    };
    const consider = (ix: any) => {
      const programId = programIdOf(ix);
      if (!programId || !programId.equals(PROGRAM_ID)) return;
      const data = dataOf(ix);
      if (!data || data[0] === logInstructionDiscriminator) return;
      originIxs.push({ discriminator: data[0]!, data });
    };
    const topIxs = msg.instructions as any[];
    const innerByIndex = new Map<number, any[]>();
    for (const inner of (ptx.meta?.innerInstructions ?? []) as any[]) {
      const arr = innerByIndex.get(inner.index) ?? [];
      arr.push(...inner.instructions);
      innerByIndex.set(inner.index, arr);
    }
    for (let i = 0; i < topIxs.length; i++) {
      consider(topIxs[i]);
      for (const ix of innerByIndex.get(i) ?? []) consider(ix);
    }
    if (!originIxs.length) return [];

    const phoenixTx = getPhoenixEventsFromTransactionData(ptx as any);
    const out: TradePrint[] = [];
    // The i-th Phoenix Log event belongs to the i-th Phoenix instruction.
    const n = Math.min(phoenixTx.instructions.length, originIxs.length);
    for (let i = 0; i < n; i++) {
      const side = this.takerSide(originIxs[i]!);
      if (!side) continue; // no attributable taker print for this instruction
      for (const ev of phoenixTx.instructions[i]!.events) {
        if (!isPhoenixMarketEventFill(ev)) continue;
        const fill = (ev as any).fields?.[0];
        if (!fill) continue;
        const price = toNum(fill.priceInTicks) * this.tickSize;
        const size = toNum(fill.baseLotsFilled) * this.baseLotSize;
        if (!(price > 0) || !(size > 0)) continue;
        out.push({ slot, price, size, side, txHash: signature });
      }
    }
    return out;
  }

  /**
   * Taker side from the instruction's own data. null = not a taker-printing
   * instruction or undecodable — the fill is skipped rather than guessed.
   */
  private takerSide(ix: { discriminator: number; data: Buffer }): "buy" | "sell" | null {
    try {
      if (ix.discriminator === swapInstructionDiscriminator) {
        // Verified byte layout: [0]=Swap, [1]=order-packet tag, [2]=side.
        // Only ImmediateOrCancel prints as a taker.
        if (ix.data[1] !== IOC_PACKET_TAG) return null;
        if (ix.data[2] === 0) return "buy"; // Bid: taker buys base (SOL)
        if (ix.data[2] === 1) return "sell"; // Ask: taker sells base
        return null;
      }
      if (ix.discriminator === placeLimitOrderInstructionDiscriminator) {
        const [args] = PlaceLimitOrderStruct.deserialize(ix.data);
        const kind = (args as any).orderPacket?.side?.__kind ?? (args as any).orderPacket?.side;
        if (kind === "Bid" || kind === "bid" || kind === 0) return "buy";
        if (kind === "Ask" || kind === "ask" || kind === 1) return "sell";
        return null;
      }
      return null;
    } catch {
      return null;
    }
  }

  summary(lastSlots: number, currentSlot: number): TradeSummary {
    const minSlot = currentSlot - lastSlots;
    let count = 0, buySol = 0, sellSol = 0, notional = 0;
    let lastPrice: number | null = null, lastSide: "buy" | "sell" | null = null;
    for (const t of this.trades) {
      if (t.slot <= minSlot) continue;
      count++;
      if (t.side === "buy") buySol += t.size; else sellSol += t.size;
      notional += t.size * t.price;
      lastPrice = t.price; lastSide = t.side;
    }
    const vol = buySol + sellSol;
    return { count, buySol, sellSol, cvdSol: buySol - sellSol, vwap: vol > 0 ? notional / vol : null, lastPrice, lastSide };
  }

  /** Newest last. */
  recent(n: number): TradePrint[] {
    return this.trades.slice(-n);
  }

  /** Prints appended since the last call (oldest first). Used to simulate maker fills in a dry run. */
  drainPrints(): TradePrint[] {
    const out = this.fresh; this.fresh = []; return out;
  }

  /** No wallet in dry run: maker fills are simulated, never observed. */
  drainFills(): never[] {
    return [];
  }
}
