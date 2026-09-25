/**
 * TypeSafe / Jev bridge for the Bun/TS side.
 *
 * Auth to api.typesafe.ai goes through the user's connected `custom.typesafe`
 * connector via the dynamic_credentials surrogate. The ONLY verified path for
 * that surrogate in this environment is Python's urllib, so this module shells
 * out to ~/workspace/skills/typesafe-ai/bin/jev.py instead of calling the API
 * directly. No raw API key is ever read, printed, persisted, or placed in an
 * env var — the key stays server-side inside the surrogate.
 *
 * Jev failure semantics (product rule): a Jev failure never auto-approves.
 * askJev throws JevError; callers must fail closed (gate → paused/review).
 */

export class JevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevError";
  }
}

export type JevAnswers = Record<string, any>;

/** Read at call time so tests can point it at a stub without reloading the module. */
const jevBin = () =>
  process.env.JEV_BIN ??
  `${process.env.HOME ?? "/home/hatch"}/workspace/skills/typesafe-ai/bin/jev.py`;
const MODEL_ID = process.env.JEV_MODEL_ID ?? "jev-latest";
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? "30000");

/**
 * Ask Jev one or more typed questions over a state.
 * `state` may be a string or an object (objects are JSON.stringified before
 * being passed to jev.py). Returns the `answers` object keyed by question id,
 * plus latency. Throws JevError on any failure (non-zero exit, bad JSON,
 * timeout).
 */
export async function askJev(
  state: string | object,
  questions: Record<string, unknown>,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<{ answers: JevAnswers; latencyMs: number }> {
  const stateText = typeof state === "string" ? state : JSON.stringify(state);
  if (!stateText || !stateText.trim()) throw new JevError("empty state");
  if (!questions || !Object.keys(questions).length) throw new JevError("no questions");

  const t0 = performance.now();
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const proc = Bun.spawn(
    ["python3", jevBin(), "ask", "--state", stateText, "--questions", JSON.stringify(questions),
      "--model", opts.model ?? MODEL_ID],
    { stdout: "pipe", stderr: "pipe" },
  );

  const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  let out: string, errText: string, code: number;
  try {
    [out, errText, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (e) {
    throw new JevError(`jev.py spawn failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(killer);
  }

  const latencyMs = performance.now() - t0;
  if (code !== 0) {
    throw new JevError(`jev.py exited ${code}: ${errText.slice(0, 300).trim() || out.slice(0, 300).trim()}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new JevError(`jev.py returned non-JSON: ${out.slice(0, 200)}`);
  }
  return { answers: parsed as JevAnswers, latencyMs };
}
