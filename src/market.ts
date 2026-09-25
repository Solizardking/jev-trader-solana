/**
 * Phoenix SOL-USDC spot market: read the book, price one post-only quote per
 * slot, confirm asynchronously.
 *
 * DRY RUN ONLY. Live signing is disabled in this build: the constructor throws
 * if a private key is configured without DRY_RUN=true, and buildPlaceIx()
 * throws unconditionally. Enabling live orders requires a separate, explicit
 * user approval of exact wallet/venue/size/risk terms — it is not a config
 * flip.
 */

import { config } from "./config";
import { loadMarket, type Book, type MarketParams } from "./book";

export type { Book, MarketParams };

export type Side = "buy" | "sell";

/**
 * This slot's order: a post-only limit order resting on Phoenix's book,
 * replacing last slot's. `sim` in a dry run (nothing is signed or sent).
 * `capped` means the position cap or a risk gate picked this side; the
 * model's probabilities still show its call.
 */
export interface Quote {
  side: Side;
  price: number; // USDC per SOL, tick aligned
  size: number; // SOL
  txHash: string | null;
  feeSol: number; // legacy field; always 0 in this build (no transactions are constructed or paid)
  cancel: number[]; // resting order sequence numbers this quote replaces
  status: "sent" | "placed" | "reverted" | "lost" | "sim";
  orderId: number | null;
  capped: boolean;
}

/** A maker fill: someone hit one of our resting orders. Arrives via the print feed, not our own receipts. */
export interface Fill {
  side: Side;
  size: number; // SOL
  price: number; // USDC per SOL: our order's price
  txHash: string | null; // the taker's transaction
  orderId: number | null;
  simulated: boolean;
}

export interface QuoteResult { slot: number; quote: Quote; canceled: number[] }

/** Phoenix SOL-USDC spot market. Dry run: nothing is signed, nothing is sent. */
export class Market {
  /** Always null in this build — there is no live wallet. */
  readonly wallet = null;
  params!: MarketParams;
  private readBookFn!: (slot: number) => Promise<Book>;

  get address(): string | null { return null; }

  async init() {
    if (!config.dryRun) {
      throw new Error(
        "live signing is disabled in this build: refusing to run with a private key. " +
        "Dry run only until exact live-trading terms are approved.",
      );
    }
    const { params, readBook } = await loadMarket();
    this.params = params;
    this.readBookFn = readBook;
  }

  /** One getAccountInfo per slot (the market account), decoded locally. */
  readBook(slot: number): Promise<Book> {
    return this.readBookFn(slot);
  }

  /**
   * Where this slot's order rests: `ticksInside` ticks inside the touch on
   * our side, never crossing. If the spread is too tight to step inside,
   * join the touch. Tick-aligned to the market's tick size.
   */
  quotePrice(side: Side, book: Book, ticksInside: number = config.quoteInsideTicks): number {
    const tick = book.tickSize;
    const step = Math.max(0, Math.round(ticksInside)) * tick;
    let p = side === "buy" ? book.bid + step : book.ask - step;
    if (side === "buy" && p >= book.ask) p = book.bid;
    if (side === "sell" && p <= book.bid) p = book.ask;
    return Math.round(p / tick) * tick;
  }

  /**
   * Dry run: no signing, no submission. Returns the simulated quote; the
   * trader treats it as resting from the next slot.
   */
  async send(slot: number, side: Side, sizeSol: number, book: Book, cancel: number[], capped: boolean, ticksInside: number = config.quoteInsideTicks): Promise<Quote> {
    const price = this.quotePrice(side, book, ticksInside);
    void slot;
    return { side, price, size: sizeSol, txHash: null, feeSol: 0, cancel, status: "sim", orderId: null, capped };
  }

  /** No live transactions in this build, so nothing is ever pending. */
  async pollPending(_slot: number): Promise<QuoteResult[]> {
    return [];
  }

  /**
   * Future live path: build the Phoenix place-limit-order instruction(s).
   * Unimplemented on purpose — live signing is disabled pending approval.
   */
  buildPlaceIx(): never {
    throw new Error("live signing is disabled in this build (buildPlaceIx not implemented)");
  }
}
