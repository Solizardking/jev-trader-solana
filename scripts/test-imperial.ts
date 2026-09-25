/**
 * Imperial perps venue feed checks (observe mode: public reads only, no JWT, no orders).
 *   bun run scripts/test-imperial.ts
 */
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

// ---------- 1. live snapshot shape ----------
{
  const { getImperial, _resetImperialForTest } = await import("../src/imperial");
  _resetImperialForTest();
  const s = await getImperial();
  ok(s.source === "imperial", "snapshot source=imperial");
  ok(s.ok && s.mark != null && s.bid != null && s.ask != null && s.mid != null,
    `snapshot ok with mark/bid/ask (mark=${s.mark?.toFixed(3)} bid=${s.bid?.toFixed(3)} ask=${s.ask?.toFixed(3)})`);
  ok(s.bid! > 0 && s.ask! > 0 && s.bid! <= s.ask!, "bid <= ask, both positive");
  ok(s.spreadBps != null && s.spreadBps >= 0 && s.spreadBps < 200, `spread sane (${s.spreadBps?.toFixed(1)} bps)`);
  ok(s.fundingPerHourPct === null || Number.isFinite(s.fundingPerHourPct),
    `funding signed-hourly-percent (got ${s.fundingPerHourPct})`);
  ok(s.openInterestUsd === null || (Number.isFinite(s.openInterestUsd) && s.openInterestUsd! >= 0),
    `OI present or null (got ${s.openInterestUsd})`);
  ok(s.stale === false, "not stale right after fetch");
}

// ---------- 2. cache: second read reuses fetchedAt ----------
{
  const { getImperial } = await import("../src/imperial");
  const a = await getImperial();
  const b = await getImperial();
  ok(a.fetchedAt === b.fetchedAt && a.mark === b.mark, "cache hit: same fetchedAt and mark on the second read");
}

// ---------- 3. sanity cross-check vs CoinGecko (best-effort) ----------
{
  const { getImperial } = await import("../src/imperial");
  const { getCoingecko } = await import("../src/coingecko");
  const s = await getImperial();
  try {
    const cg = await getCoingecko();
    if (cg.ok && cg.priceUsd != null && s.mark != null) {
      const dev = Math.abs(s.mark - cg.priceUsd) / cg.priceUsd;
      ok(dev < 0.02, `imperial perps mark within 2% of CoinGecko SOL ($${s.mark.toFixed(2)} vs $${cg.priceUsd.toFixed(2)})`);
    } else {
      console.log("SKIP  coingecko sanity (coingecko feed unavailable — fail-soft)");
    }
  } catch {
    console.log("SKIP  coingecko sanity (coingecko feed unavailable — fail-soft)");
  }
}

// ---------- 4. staleness rule ----------
{
  const { imperialFreshEnough, _resetImperialForTest } = await import("../src/imperial");
  _resetImperialForTest();
  const old = {
    source: "imperial" as const, mark: 1, bid: 1, ask: 1, mid: 1, spreadBps: 0,
    fundingPerHourPct: null, openInterestUsd: null,
    fetchedAt: Date.now() - 301_000, ageMs: 301_000, stale: true, ok: true,
  };
  ok(!imperialFreshEnough(old), "snapshot older than 300s is not fresh enough (blocks perp trades)");
  ok(!imperialFreshEnough({ ...old, ok: false }), "unknown snapshot is not fresh enough");
}

// ---------- 5. fail-soft: network blocked -> unknown snapshot, never throws ----------
{
  const script = `
    const { getImperial, imperialFreshEnough, _resetImperialForTest } = await import("../src/imperial");
    _resetImperialForTest();
    const s = await getImperial(); // must not throw
    console.log(JSON.stringify({ ok: s.ok, stale: s.stale, mark: s.mark, freshEnough: imperialFreshEnough(s) }));
  `;
  const proc = Bun.spawn(["/opt/hatch-image/bin/bun", "-e", script], {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, IMPERIAL_BASE_URL: "http://127.0.0.1:9/nope" },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const exit = await proc.exited;
  const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
  ok(exit === 0 && parsed.ok === false && parsed.stale === true && parsed.mark === null && parsed.freshEnough === false,
    "network-blocked fetch fails soft to an unknown snapshot (no throw)");
}

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
