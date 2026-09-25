/** Probe: load the Phoenix SOL-USDC market and print the top of book. */
import { loadMarket } from "../src/book";

const { params, readBook } = await loadMarket();
console.log("market loaded");
console.log("tickSize (USDC/SOL):", params.tickSize);
console.log("baseLotSize (SOL):", params.baseLotSize);
console.log("decimals:", params.baseDecimals, "/", params.quoteDecimals);

const book = await readBook(0);
console.log(`bid ${book.bid} | mid ${book.mid.toFixed(4)} | ask ${book.ask}`);
console.log(`spread ${book.spreadBps.toFixed(2)} bps, imbalance ${book.imbalance.toFixed(3)}`);
console.log("bids:", book.levels.bids.map(([p, q]) => `${p.toFixed(3)}x${q.toFixed(4)}`).join(" "));
console.log("asks:", book.levels.asks.map(([p, q]) => `${p.toFixed(3)}x${q.toFixed(4)}`).join(" "));
console.log("depthBps:", JSON.stringify(book.depthBps));
