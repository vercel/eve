import { z } from "zod";
import { publicUrl } from "../parallel";
import { type Destination, required, frequencyInput, monitorTimestamp } from "./config";

const remoteSchema = z.object({ monitor_id: z.string().min(1), status: z.enum(["active", "cancelled"]), frequency: frequencyInput, metadata: z.record(z.string(), z.string()).nullish() });
const citation = z.object({ url: publicUrl.nullable().catch(null) });
export const eventSchema = z.discriminatedUnion("event_type", [
  z.object({ event_type: z.literal("event_stream"), event_id: z.string(), event_group_id: z.string(), event_date: z.string().nullish(), output: z.object({ type: z.enum(["text", "json"]), content: z.union([z.string(), z.record(z.string(), z.unknown())]), basis: z.array(z.object({ citations: z.array(citation).default([]) })).default([]) }) }),
  z.object({ event_type: z.literal("completion"), timestamp: monitorTimestamp }),
  z.object({ event_type: z.literal("error"), timestamp: monitorTimestamp, error_message: z.string() }),
]);
export type MonitorEvent = z.infer<typeof eventSchema>;
export interface RemoteMonitor { monitor_id: string; status: string; frequency: string; metadata?: Record<string, string> | null }
export interface MonitorProvider {
  create(query: string, watchId: string, origin: string, frequency?: string): Promise<RemoteMonitor>;
  list(cursor?: string): Promise<{ monitors: RemoteMonitor[]; next_cursor?: string | null }>;
  events(id: string, group?: string, cursor?: string): Promise<{ events: unknown[]; next_cursor?: string | null }>;
  cancel(id: string): Promise<void>;
  update(id: string, frequency: string): Promise<RemoteMonitor>;
}
export class ProviderError extends Error {
  constructor(readonly status: number, readonly retryAfter = 0) { super(`Provider HTTP ${status}`); }
}
export async function readBounded(response: Response, maxBytes = 1_048_576): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Response exceeds size limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function request(url: string, key: string, method = "GET", body?: unknown, bearer = false): Promise<unknown> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${key}` } : { "x-api-key": key }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8_000), redirect: "error", cache: "no-store" });
  if (!response.ok) {
    await response.body?.cancel();
    const value = response.headers.get("retry-after"), seconds = Number(value);
    const delay = value ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()) : 0;
    throw new ProviderError(response.status, Math.max(0, Math.min(delay || 0, 86_400_000)));
  }
  const text = await readBounded(response);
  return text ? JSON.parse(text) : null;
}
const path = (id: string) => `/monitors/${encodeURIComponent(id)}`;
const call = (endpoint: string, method = "GET", body?: unknown) => request(`https://api.parallel.ai/v1${endpoint}`, required("PARALLEL_API_KEY"), method, body);
export const parallelMonitors: MonitorProvider = {
  async create(query, watchId, origin, frequency = "1d") {
    return remoteSchema.parse(await call("/monitors", "POST", { type: "event_stream", frequency: frequencyInput.parse(frequency), processor: "lite", settings: { query, include_backfill: false }, metadata: { bell_watch_id: watchId }, webhook: { url: `${origin}/api/parallel/monitors/webhook`, event_types: ["monitor.event.detected", "monitor.execution.completed", "monitor.execution.failed"] } }));
  },
  async list(cursor) {
    const params = new URLSearchParams({ type: "event_stream", limit: "100" });
    params.append("status", "active"); params.append("status", "cancelled"); if (cursor) params.set("cursor", cursor);
    return z.object({ monitors: z.array(remoteSchema), next_cursor: z.string().nullish() }).parse(await call(`/monitors?${params}`));
  },
  async events(id, group, cursor) {
    const params = new URLSearchParams(group ? { event_group_id: group } : { include_completions: "true", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    return z.object({ events: z.array(z.unknown()), next_cursor: z.string().nullish() }).parse(await call(`${path(id)}/events?${params}`));
  },
  async update(id, frequency) {
    return remoteSchema.parse(await call(`${path(id)}/update`, "POST", { frequency: frequencyInput.parse(frequency) }));
  },
  async cancel(id) { await call(`${path(id)}/cancel`, "POST"); },
};
export async function sendLinq(destination: Destination, text: string, key: string): Promise<string> {
  const response = await request(`https://api.linqapp.com/api/partner/v3/chats/${encodeURIComponent(destination.chat)}/messages`, required("LINQ_API_KEY"), "POST", { message: { parts: [{ type: "text", value: text }], idempotency_key: key } }, true);
  return z.object({ message: z.object({ id: z.string() }) }).parse(response).message.id;
}
