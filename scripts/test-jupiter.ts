/**
 * Jupiter spot venue feed checks.
 *   bun run scripts/test-jupiter.ts
 * Read-only. Env overrides must be set before the module is imported, so
 * the feed modules are imported dynamically per scenario.
 */
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

// ---------- 1. live snapshot shape ----------
{
  const { getJupiter, _resetJupiterForTest } = await import("../src/jupiter");
  _resetJupiterForTest();
  const s = await getJupiter();
  ok(s.source === "jupiter", "snapshot source=jupiter");
  ok(s.ok && s.bid != null && s.ask != null && s.mid != null,
    `snapshot ok with bid/ask/mid (bid=${s.bid?.toFixed(3)} ask=${s.ask?.toFixed(3)})`);
  ok(s.bid! > 0 && s.ask! > 0 && s.bid! <= s.ask!, "bid <= ask, both positive");
  ok(s.spreadBps != null && s.spreadBps >= 0 && s.spreadBps < 200, `spread sane (${s.spreadBps?.toFixed(1)} bps)`);
  ok(typeof s.fetchedAt === "number" && s.fetchedAt > 0 && s.ageMs >= 0 && s.ageMs < 30000,
    "freshness fields present and fresh");
  ok(s.stale === false, "not stale right after fetch");
  ok(s.refPriceUsd != null && Math.abs(s.mid! - s.refPriceUsd) / s.refPriceUsd < 0.01,
    `mid tracks the Lite reference price (ref=${s.refPriceUsd?.toFixed(3)})`);
}

// ---------- 2. cache: second read reuses fetchedAt, no second fetch ----------
{
  const { getJupiter } = await import("../src/jupiter");
  const a = await getJupiter();
  const b = await getJupiter();
  ok(a.fetchedAt === b.fetchedAt && a.bid === b.bid, "cache hit: same fetchedAt and values on the second read");
}

// ---------- 3. sanity cross-check vs CoinGecko (best-effort) ----------
{
  const { getJupiter } = await import("../src/jupiter");
  const { getCoingecko } = await import("../src/coingecko");
  const s = await getJupiter();
  try {
    const cg = await getCoingecko();
    if (cg.ok && cg.priceUsd != null && s.mid != null) {
      const dev = Math.abs(s.mid - cg.priceUsd) / cg.priceUsd;
      ok(dev < 0.02, `jupiter mid within 2% of CoinGecko SOL ($${s.mid.toFixed(2)} vs $${cg.priceUsd.toFixed(2)})`);
    } else {
      console.log("SKIP  coingecko sanity (coingecko feed unavailable — fail-soft)");
    }
  } catch {
    console.log("SKIP  coingecko sanity (coingecko feed unavailable — fail-soft)");
  }
}

// ---------- 4. staleness rule: old data must not be treated as fresh ----------
{
  const { jupiterFreshEnough, _resetJupiterForTest } = await import("../src/jupiter");
  _resetJupiterForTest();
  const old = {
    source: "jupiter" as const, bid: 1, ask: 1, mid: 1, spreadBps: 0, refPriceUsd: 1,
    fetchedAt: Date.now() - 301_000, ageMs: 301_000, stale: true, ok: true,
  };
  ok(!jupiterFreshEnough(old), "snapshot older than 300s is not fresh enough (pauses quoting)");
  ok(!jupiterFreshEnough({ ...old, ok: false }), "unknown snapshot is not fresh enough");
  const fresh = { ...old, fetchedAt: Date.now() - 5_000, ageMs: 5_000, stale: true, ok: true };
  ok(jupiterFreshEnough(fresh), "5s-old snapshot is fresh enough");
}

// ---------- 5. fail-soft: network blocked -> unknown snapshot, never throws ----------
{
  // Isolated subprocess: env must be read at module load, so a fresh process is the honest test.
  const script = `
    const { getJupiter, jupiterFreshEnough, _resetJupiterForTest } = await import("../src/jupiter");
    _resetJupiterForTest();
    const s = await getJupiter(); // must not throw
    console.log(JSON.stringify({ ok: s.ok, stale: s.stale, bid: s.bid, freshEnough: jupiterFreshEnough(s) }));
  `;
  const proc = Bun.spawn(["/opt/hatch-image/bin/bun", "-e", script], {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, JUPITER_BASE_URL: "http://127.0.0.1:9/nope" },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
  ok(exit === 0 && parsed.ok === false && parsed.stale === true && parsed.bid === null && parsed.freshEnough === false,
    `network-blocked fetch fails soft to an unknown snapshot (no throw)${err.trim() ? " [stderr noted]" : ""}`);
}

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
