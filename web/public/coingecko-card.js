/* CoinGecko-style price card for the jev-trader-solana dashboard.
 * Drop-in: no build step, no framework. Exposes window.CoinGeckoCard.
 *
 *   CoinGeckoCard.render(el, snapshot)   // one-shot render
 *   CoinGeckoCard.mount(el, fetchSnapshot, intervalMs) // auto-refresh loop
 *
 * `snapshot` matches the serialized CoingeckoSnapshot from src/coingecko.ts:
 *   { source, priceUsd, change24hPct, high24h, low24h, volume24hUsd,
 *     marketCapUsd, fetchedAt, ageMs, stale, ok }
 * Unknown fields (null) render as "—". Stale/unknown states are shown honestly.
 */
(function () {
  "use strict";

  function esc(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmtMoney(v, digits) {
    if (v == null) return "—";
    return "$" + v.toLocaleString("en-US", {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
  }

  function fmtCompact(v) {
    if (v == null) return "—";
    const abs = Math.abs(v);
    if (abs >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return "$" + (v / 1e3).toFixed(2) + "K";
    return fmtMoney(v, 2);
  }

  function fmtPct(v) {
    if (v == null) return "—";
    const sign = v > 0 ? "+" : "";
    return sign + v.toFixed(2) + "%";
  }

  function ageLabel(s) {
    if (!s.ok) return "no data yet";
    if (!isFinite(s.ageMs)) return "unknown age";
    const sec = Math.round(s.ageMs / 1000);
    if (sec < 60) return sec + "s ago";
    const min = Math.floor(sec / 60);
    if (min < 60) return min + "m ago";
    return Math.floor(min / 60) + "h ago";
  }

  function render(el, s) {
    const chg = s.change24hPct;
    const chgClass = chg == null ? "cg-neutral" : chg >= 0 ? "cg-up" : "cg-down";
    const arrow = chg == null ? "" : chg >= 0 ? "▲" : "▼";
    const stateClass = !s.ok ? "cg-unknown" : s.stale ? "cg-stale" : "cg-live";
    const banner = !s.ok
      ? '<div class="cg-banner cg-banner-unknown">Price unavailable — CoinGecko fetch has not succeeded yet.</div>'
      : s.stale
        ? '<div class="cg-banner cg-banner-stale">STALE — showing last known price from ' + esc(ageLabel(s)) + ".</div>"
        : "";

    el.className = "cg-card " + stateClass;
    el.innerHTML =
      banner +
      '<div class="cg-head">' +
        '<div class="cg-pair"><span class="cg-icon">◎</span><div>' +
          '<div class="cg-name">Solana</div>' +
          '<div class="cg-ticker">SOL / USD</div>' +
        "</div></div>" +
        '<div class="cg-price-wrap">' +
          '<div class="cg-price">' + esc(fmtMoney(s.priceUsd, 2)) + "</div>" +
          '<div class="cg-change ' + chgClass + '">' + esc(arrow + " " + fmtPct(chg)) +
            '<span class="cg-change-sub">24h</span></div>' +
        "</div>" +
      "</div>" +
      '<div class="cg-grid">' +
        '<div class="cg-stat"><span class="cg-label">24h High</span><span class="cg-value">' + esc(fmtMoney(s.high24h, 2)) + "</span></div>" +
        '<div class="cg-stat"><span class="cg-label">24h Low</span><span class="cg-value">' + esc(fmtMoney(s.low24h, 2)) + "</span></div>" +
        '<div class="cg-stat"><span class="cg-label">24h Volume</span><span class="cg-value">' + esc(fmtCompact(s.volume24hUsd)) + "</span></div>" +
        '<div class="cg-stat"><span class="cg-label">Market Cap</span><span class="cg-value">' + esc(fmtCompact(s.marketCapUsd)) + "</span></div>" +
      "</div>" +
      '<div class="cg-foot">' +
        '<span class="cg-attrib">Data: CoinGecko</span>' +
        '<span class="cg-fresh">updated ' + esc(ageLabel(s)) + "</span>" +
      "</div>";
  }

  function mount(el, fetchSnapshot, intervalMs) {
    let timer = null;
    let stopped = false;
    async function tick() {
      try {
        const s = await fetchSnapshot();
        if (!stopped) render(el, s);
      } catch (e) {
        if (!stopped) {
          console.error("[coingecko-card] fetch failed:", e);
          render(el, {
            source: "coingecko", priceUsd: null, change24hPct: null,
            high24h: null, low24h: null, volume24hUsd: null, marketCapUsd: null,
            fetchedAt: 0, ageMs: Infinity, stale: true, ok: false,
          });
        }
      }
    }
    tick();
    if (intervalMs && intervalMs > 0) timer = setInterval(tick, intervalMs);
    return function unmount() {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }

  window.CoinGeckoCard = { render: render, mount: mount };
})();
