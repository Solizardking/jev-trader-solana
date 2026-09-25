const env = (key: string, fallback?: string) => process.env[key] ?? fallback;

export const config = {
  /** HTTP Solana JSON-RPC. For local dev you can point this at scripts/rpc-bridge.py. */
  rpcUrl: env("RPC_URL", "https://api.mainnet-beta.solana.com")!,
  /**
   * Venue mode:
   *   "multi"   — Jupiter + DFlow spot (best-price routing) + Imperial
   *               Phoenix-routed perps. Default. No RPC, no Phoenix spot book.
   *   "phoenix" — legacy Phoenix SOL-USDC spot market-maker (deprecated;
   *               the book is fossilized and the trader fails closed on it).
   */
  venue: env("VENUE", "multi") as "multi" | "phoenix",
  /** Phoenix SOL-USDC spot market (Ellipsis Labs mainnet_markets.json). Legacy path only. */
  market: env("MARKET", "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg")!,
  /** Base58 secret key. Absent (or DRY_RUN=true) => dry run: real book, real decisions, simulated fills. */
  privateKey: env("PRIVATE_KEY"),
  dryRun: env("DRY_RUN") === "true" || !env("PRIVATE_KEY"),
  tradeSizeSol: Number(env("TRADE_SIZE_SOL", "0.1")),
  maxPositionSol: Number(env("MAX_POSITION_SOL", "1")),
  bankrollUsd: Number(env("BANKROLL_USD", "100")), // used for pnlPct
  /** Quote this many ticks inside the touch (0 = join the best bid/ask). Never crosses: clamps to the touch when the spread is too tight. */
  quoteInsideTicks: Number(env("QUOTE_INSIDE_TICKS", "1")),
  /** Priority fee in microlamports, added to every live tx. */
  priorityFeeMicroLamports: Number(env("PRIORITY_FEE_MICROLAMPORTS", "10000")),
  /** Give up on a tx with no confirmation after this many slots. */
  pendingSlots: Number(env("PENDING_SLOTS", "25")),
  /** How often to refresh balances / fee estimates. */
  refreshSlots: Number(env("REFRESH_SLOTS", "500")),
  /** The model is asked about the move over this many slots (~400 ms each). */
  horizonSlots: Number(env("HORIZON_SLOTS", "75")),
  /** Poll the taker-print feed every N slots. */
  printsEverySlots: Number(env("PRINTS_EVERY_SLOTS", "5")),
  model: env("MODEL", "mock") as "mock" | "jev",
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  jevUsdPerMTok: 0.042,
  /** CoinGecko cache TTL: at most one free-API request per window, shared by all consumers. */
  coingeckoTtlMs: Number(env("COINGECKO_TTL_MS", "60000")),
  /** Pause quoting when CoinGecko data is older than this (no trustworthy reference price). */
  coingeckoStaleMs: Number(env("COINGECKO_STALE_MS", "300000")),
  /** Regime (Jev) judgments are cached this long; one in-flight call is shared. */
  regimeTtlMs: Number(env("REGIME_TTL_MS", "15000")),
  /** Volatility score at or above this pauses quoting (score levels 0 calm .. 3 extreme). */
  volPauseScore: Number(env("REGIME_VOL_PAUSE_SCORE", "2.5")),
  /** Hard timeout for a Jev call; failure fails the regime gate closed (paused). */
  jevTimeoutMs: Number(env("JEV_TIMEOUT_MS", "30000")),
  port: Number(env("PORT", "3000")),
  historySize: 1000,
  /* --- multi-venue (Jupiter + DFlow spot, Imperial perps) --- */
  /** One decision cycle every N ms in multi-venue mode (feeds cache below). */
  cycleMs: Number(env("CYCLE_MS", "5000")),
  /** Jupiter feed: cache TTL (at most one price+quotes fetch per window) and staleness cutoff. */
  jupiterTtlMs: Number(env("JUPITER_TTL_MS", "10000")),
  jupiterStaleMs: Number(env("JUPITER_STALE_MS", "300000")),
  /** DFlow feed: cache TTL and staleness cutoff. */
  dflowTtlMs: Number(env("DFLOW_TTL_MS", "10000")),
  dflowStaleMs: Number(env("DFLOW_STALE_MS", "300000")),
  /** Realtime Pump.fun launch tape from the CLAWD websocket. */
  pumpWsUrl: env("PUMP_WS_URL", "wss://clawd-ws.fly.dev/ws")!,
  pumpHealthUrl: env("PUMP_HEALTH_URL", "https://clawd-ws.fly.dev/health")!,
  pumpTapeMax: Number(env("PUMP_TAPE_MAX", "200")),
  /** Stonk.fun public market data. Reads are keyless; writes stay out of this runtime. */
  stonkBaseUrl: env("STONK_BASE_URL", "https://www.stonkfun.xyz/api/public/v1")!,
  stonkTtlMs: Number(env("STONK_TTL_MS", "15000")),
  stonkFetchTimeoutMs: Number(env("STONK_FETCH_TIMEOUT_MS", "12000")),
  /** Jupiter Swap V2 order preview. Execution/signing is intentionally absent. */
  jupiterSwapBaseUrl: env("JUPITER_SWAP_BASE_URL", "https://api.jup.ag/swap/v2")!,
  jupiterApiKey: env("JUPITER_API_KEY"),
  jupiterOrderTimeoutMs: Number(env("JUPITER_ORDER_TIMEOUT_MS", "12000")),
  /** Imperial perps feed: cache TTL and staleness cutoff. */
  imperialTtlMs: Number(env("IMPERIAL_TTL_MS", "10000")),
  imperialStaleMs: Number(env("IMPERIAL_STALE_MS", "300000")),
  /** SOL size used to derive each spot venue's executable bid/ask proxy. */
  spotQuoteSizeSol: Number(env("SPOT_QUOTE_SIZE_SOL", "0.1")),
  /** Simulated perps order size (SOL) and max 1x position size. No leverage, ever. */
  perpSizeSol: Number(env("PERP_SIZE_SOL", "0.1")),
  maxPerpSol: Number(env("MAX_PERP_SOL", "0.5")),
  /** Simulated execution fees, bps on notional. */
  spotFeeBps: Number(env("SPOT_FEE_BPS", "5")),
  perpFeeBps: Number(env("PERP_FEE_BPS", "5")),
  /** Timeout for the DFlow quote subprocess (its own urllib timeout is 60s). */
  dflowSubprocTimeoutMs: Number(env("DFLOW_SUBPROC_TIMEOUT_MS", "15000")),
};
