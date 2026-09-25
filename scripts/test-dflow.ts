/**
 * DFlow spot venue feed checks.
 *   bun run scripts/test-dflow.ts
 * Read-only quotes only (no userPublicKey, no transaction attached).
 * The dflow skill's Python CLI attaches the user's stored custom.dflow
 * credential through its own approved path; this module never touches it.
 */
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

// ---------- 1. live snapshot shape ----------
{
  const { getDflow, _resetDflowForTest } = await import("../src/dflow");
  _resetDflowForTest();
  const s = await getDflow();
  ok(s.source === "dflow", "snapshot source=dflow");
  ok(s.ok && s.bid != null && s.ask != null && s.mid != null,
    `snapshot ok with bid/ask/mid (bid=${s.bid?.toFixed(3)} ask=${s.ask?.toFixed(3)})`);
  ok(s.bid! > 0 && s.ask! > 0 && s.bid! <= s.ask!, "bid <= ask, both positive");
  ok(s.spreadBps != null && s.spreadBps >= 0 && s.spreadBps < 200, `spread sane (${s.spreadBps?.toFixed(1)} bps)`);
  ok(s.stale === false, "not stale right after fetch");
}

// ---------- 2. cache: second read reuses fetchedAt ----------
{
  const { getDflow } = await import("../src/dflow");
  const a = await getDflow();
  const b = await getDflow();
  ok(a.fetchedAt === b.fetchedAt && a.bid === b.bid, "cache hit: same fetchedAt and values on the second read");
}

// ---------- 3. sanity cross-check vs CoinGecko (best-effort) ----------
{
  const { getDflow } = await import("../src/dflow");
  const { getCoingecko } = await import("../src/coingecko");
  const s = await getDflow();
  try {
    const cg = await getCoingecko();
    if (cg.ok && cg.priceUsd != null && s.mid != null) {
      const dev = Math.abs(s.mid - cg.priceUsd) / cg.priceUsd;
      ok(dev < 0.02, `dflow mid within 2% of CoinGecko SOL ($${s.mid.toFixed(2)} vs $${cg.priceUsd.toFixed(2)})`);
    } else {
      console.log("SKIP  coingecko sanity (coingecko feed unavailable — fail-soft)");
    }
  } catch {
    console.log("SKIP  coingecko sanity (coingecko feed unavailable — fail-soft)");
  }
}

// ---------- 4. staleness rule ----------
{
  const { dflowFreshEnough, _resetDflowForTest } = await import("../src/dflow");
  _resetDflowForTest();
  const old = {
    source: "dflow" as const, bid: 1, ask: 1, mid: 1, spreadBps: 0,
    fetchedAt: Date.now() - 301_000, ageMs: 301_000, stale: true, ok: true,
  };
  ok(!dflowFreshEnough(old), "snapshot older than 300s is not fresh enough (pauses quoting)");
  ok(!dflowFreshEnough({ ...old, ok: false }), "unknown snapshot is not fresh enough");
}

// ---------- 5. fail-soft: broken quote tool -> unknown snapshot, never throws ----------
{
  // Isolated subprocess: the quote bin is resolved at module load, so a fresh process is the honest test.
  const script = `
    const { getDflow, dflowFreshEnough, _resetDflowForTest } = await import("../src/dflow");
    _resetDflowForTest();
    const s = await getDflow(); // must not throw
    console.log(JSON.stringify({ ok: s.ok, stale: s.stale, bid: s.bid, freshEnough: dflowFreshEnough(s) }));
  `;
  const proc = Bun.spawn(["/opt/hatch-image/bin/bun", "-e", script], {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, DFLOW_QUOTE_BIN: "/bin/false" }, // CLI exits 1 immediately
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const exit = await proc.exited;
  const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
  ok(exit === 0 && parsed.ok === false && parsed.stale === true && parsed.bid === null && parsed.freshEnough === false,
    "broken quote tool fails soft to an unknown snapshot (no throw)");
}

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
