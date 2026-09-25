/**
 * Jupiter Swap V2 order preview.
 *
 * This obtains quotes or unsigned wallet-bound transactions from /order.
 * It never signs and never calls /execute.
 */
import { config } from "./config";

export interface JupiterOrderPreview {
  ok: boolean;
  error: string | null;
  order: unknown | null;
  unsignedTransaction: boolean;
  router: string | null;
  requestId: string | null;
  outAmount: string | null;
}

const allowedMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const allowedAmount = /^[0-9]+$/;

export async function previewJupiterOrder(params: URLSearchParams): Promise<JupiterOrderPreview> {
  const inputMint = params.get("inputMint") ?? "";
  const outputMint = params.get("outputMint") ?? "";
  const amount = params.get("amount") ?? "";
  const taker = params.get("taker") ?? "";
  const slippageBps = params.get("slippageBps") ?? "";
  if (!allowedMint.test(inputMint) || !allowedMint.test(outputMint)) {
    return fail("inputMint and outputMint must be base58 mint addresses");
  }
  if (!allowedAmount.test(amount) || BigInt(amount) <= 0n) {
    return fail("amount must be a positive atomic integer");
  }
  if (taker && !allowedMint.test(taker)) return fail("taker must be a base58 wallet address");
  if (slippageBps && (!allowedAmount.test(slippageBps) || Number(slippageBps) > 10_000)) {
    return fail("slippageBps must be 0..10000");
  }

  const query = new URLSearchParams({ inputMint, outputMint, amount });
  if (taker) query.set("taker", taker);
  if (slippageBps) query.set("slippageBps", slippageBps);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.jupiterOrderTimeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "jev-trader-solana/1.0" };
    if (config.jupiterApiKey) headers["x-api-key"] = config.jupiterApiKey;
    const res = await fetch(`${config.jupiterSwapBaseUrl}/order?${query}`, { signal: ctrl.signal, headers });
    const text = await res.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!res.ok) return fail(`jupiter /order http ${res.status}`, body);
    return {
      ok: true,
      error: null,
      order: body,
      unsignedTransaction: typeof body.transaction === "string" && body.transaction.length > 0,
      router: typeof body.router === "string" ? body.router : null,
      requestId: typeof body.requestId === "string" ? body.requestId : null,
      outAmount: typeof body.outAmount === "string" ? body.outAmount : null,
    };
  } catch (error) {
    return fail((error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

function fail(error: string, order: unknown = null): JupiterOrderPreview {
  return { ok: false, error, order, unsignedTransaction: false, router: null, requestId: null, outAmount: null };
}
