/**
 * Validate the taker-print feed against known Phoenix fills.
 *   RPC_URL=http://127.0.0.1:8899 bun run scripts/test-trades.ts
 * Read-only: getAccountInfo + getSignaturesForAddress + getTransaction.
 * No wallet, no signing, no submission.
 *
 * Ground truth: the 2026-09-25 market-data diagnosis decoded these fills
 * from the market's real transaction history (SDK event path).
 */
import { config } from "../src/config";
import { loadMarket } from "../src/book";
import { TradeFeed } from "../src/trades";

const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

// signature -> expected prints [price, size][]
const KNOWN: Record<string, [number, number][]> = {
  "3GUyGu7vSWcSfEjUQbiQZ61CRjm1kLztEQRF6WM3GsZwKwxod971rh919MbzDSky4t7e3dZ8k8JRLEY5fGBsmwR7": [[114.0, 0.006]],
  "4E7pYMi9arZhJ6L8KE7Huy6mF2cZk6jM5vmPzP8qFupMcrqYRdpqEgbzavBfByVE5ohUhMEsmXhfpv78dLMBgmg6": [[114.009, 0.175], [114.0, 0.025]],
  "33ZXhwmXUfsUZ5dvTWqyA1ZAzEjDtu5Ev9RktVvQ1GjGKTwfvyhArNspAumEnMmzbZct8fbdfjBGdoTAS2agBQBk": [[114.009, 0.009]],
  "1a1Su2Zi9GuCDiTHte8NvpgWhsemnQV7qDgyxkZQcWN5vQV5rboBg444bdJPVYK4iNMPF9azLfPZGxD6f787Uzv": [[117.227, 0.06]],
};

const { params } = await loadMarket();
ok(Math.abs(params.tickSize - 0.001) < 1e-9, `tickSize is 0.001 (got ${params.tickSize})`);
ok(Math.abs(params.baseLotSize - 0.001) < 1e-9, `baseLotSize is 0.001 (got ${params.baseLotSize})`);

const feed = new TradeFeed({
  market: config.market,
  url: config.rpcUrl,
  tickSize: params.tickSize,
  baseLotSize: params.baseLotSize,
});

for (const [sig, expected] of Object.entries(KNOWN)) {
  let prints;
  try {
    prints = await feed.printsForSignature(sig);
  } catch (e) {
    console.log(`FAIL  ${sig.slice(0, 8)}… threw: ${(e as Error).message}`);
    process.exitCode = 1;
    continue;
  }
  const match =
    prints.length === expected.length &&
    expected.every(([p, s]) =>
      prints.some((x) => Math.abs(x.price - p) < 1e-6 && Math.abs(x.size - s) < 1e-9),
    );
  const sidesOk = prints.every((x) => x.side === "buy" || x.side === "sell");
  ok(match, `${sig.slice(0, 8)}… -> ${prints.length} print(s) ${prints.map((x) => `${x.side} ${x.size}@${x.price}`).join(", ")} (expected ${expected.map(([p, s]) => `${s}@${p}`).join(", ")})`);
  ok(sidesOk, `${sig.slice(0, 8)}… every print has an attributed taker side (never guessed)`);
}

// A tx with no Phoenix fills decodes to nothing (and never throws).
const quiet = await feed.printsForSignature("3GUyGu7vSWcSfEjUQbiQZ61CRjm1kLztEQRF6WM3GsZwKwxod971rh919MbzDSky4t7e3dZ8k8JRLEY5fGBsmwR7".slice(0, 0) + "1111111111111111111111111111111111111111111111111111111111111111").catch(() => []);
ok(quiet.length === 0, "non-Phoenix signature decodes to zero prints");

// First poll must not replay stale history: warm the cursor, then nothing new is emitted.
await feed.poll(1_000_000);
const replayed = feed.drainPrints();
ok(replayed.length === 0, `first poll replays zero historical fills (cursor established, got ${replayed.length})`);

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
