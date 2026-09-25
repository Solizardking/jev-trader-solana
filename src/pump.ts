/**
 * Realtime Pump.fun launch tape from the CLAWD websocket.
 *
 * The websocket payload is untrusted market data. This module stores only
 * bounded, selected fields and never treats payload text as instructions.
 */
import { config } from "./config";

export interface PumpEvent {
  id: string;
  receivedAt: number;
  eventTs: number | null;
  type: string;
  mint: string | null;
  signature: string | null;
  name: string | null;
  symbol: string | null;
  raw: Record<string, unknown>;
}

export interface PumpSnapshot {
  source: "clawd-pump-ws";
  url: string;
  connected: boolean;
  status: "idle" | "connecting" | "open" | "closed" | "error";
  lastError: string | null;
  connectedAt: number | null;
  lastEventAt: number | null;
  ageMs: number | null;
  totalEvents: number;
  tape: PumpEvent[];
}

let ws: WebSocket | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let status: PumpSnapshot["status"] = "idle";
let lastError: string | null = null;
let connectedAt: number | null = null;
let lastEventAt: number | null = null;
let totalEvents = 0;
const tape: PumpEvent[] = [];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const firstString = (obj: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

const firstNumber = (obj: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length > 0) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }
  }
  return null;
};

function normalize(raw: unknown): PumpEvent {
  const obj = asRecord(raw);
  const nested = asRecord(obj.data ?? obj.launch ?? obj.token ?? obj.payload);
  const flat = { ...obj, ...nested };
  const mint = firstString(flat, ["mint", "tokenMint", "baseMint", "address"]);
  const signature = firstString(flat, ["signature", "sig", "tx", "txid", "transactionSignature"]);
  const type = firstString(flat, ["type", "event", "kind"]) ?? "pump";
  const eventTs = firstNumber(flat, ["timestamp", "ts", "createdAt", "slotTime"]);
  const id = mint ?? signature ?? `${Date.now()}-${totalEvents}`;
  return {
    id,
    receivedAt: Date.now(),
    eventTs,
    type,
    mint,
    signature,
    name: firstString(flat, ["name", "tokenName"]),
    symbol: firstString(flat, ["symbol", "ticker"]),
    raw: flat,
  };
}

function push(raw: unknown) {
  const event = normalize(raw);
  lastEventAt = event.receivedAt;
  totalEvents++;
  const existing = tape.findIndex((item) => item.id === event.id);
  if (existing >= 0) tape.splice(existing, 1);
  tape.unshift(event);
  if (tape.length > config.pumpTapeMax) tape.length = config.pumpTapeMax;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2500);
}

function connect() {
  if (!started || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  status = "connecting";
  try {
    ws = new WebSocket(config.pumpWsUrl);
    ws.onopen = () => {
      status = "open";
      connectedAt = Date.now();
      lastError = null;
    };
    ws.onmessage = (message) => {
      try {
        const text = typeof message.data === "string" ? message.data : String(message.data);
        push(JSON.parse(text));
      } catch (error) {
        lastError = `bad pump payload: ${(error as Error).message}`;
      }
    };
    ws.onerror = () => {
      status = "error";
      lastError = "pump websocket error";
    };
    ws.onclose = () => {
      status = "closed";
      ws = null;
      scheduleReconnect();
    };
  } catch (error) {
    status = "error";
    lastError = (error as Error).message;
    scheduleReconnect();
  }
}

export function startPumpStream() {
  if (started) return;
  started = true;
  connect();
}

export function getPumpSnapshot(): PumpSnapshot {
  const connected = ws?.readyState === WebSocket.OPEN;
  const ageMs = lastEventAt == null ? null : Date.now() - lastEventAt;
  return {
    source: "clawd-pump-ws",
    url: config.pumpWsUrl,
    connected,
    status,
    lastError,
    connectedAt,
    lastEventAt,
    ageMs,
    totalEvents,
    tape: [...tape],
  };
}
