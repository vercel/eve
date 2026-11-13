import { afterEach, describe, expect, it, vi } from "vitest";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { receiveWebhook, processMonitors } from "../server/monitors/http";
import { MonitorService } from "../server/monitors/service";
import { parallelMonitors, ProviderError, readBounded, sendLinq } from "../server/monitors/provider";
import { frequencyInput, monitorTimestamp } from "../server/monitors/config";
import { eventSchema } from "../server/monitors/provider";
import { watchDestination, watchIdentity } from "../agent/lib/monitors";
import { MonitorStore, monitorStore } from "../server/monitors/store";
import { Pool } from "pg";
import type { ToolContext } from "eve/tools";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("monitor HTTP boundaries", () => {
  it.each(["1h", "6h", "1d", "1w", "30d", "720h", "4w"])("accepts supported frequency %s", value => {
    expect(frequencyInput.safeParse(value).success).toBe(true);
  });
  it.each(["0h", "5m", "1.5h", "31d", "5w", "721h", "-1h", "daily", ""])("rejects unsupported frequency %s", value => {
    expect(frequencyInput.safeParse(value).success).toBe(false);
  });
  it("normalizes equivalent timestamps without losing fractional precision", () => {
    expect(monitorTimestamp.parse("2026-10-30T05:00:00.123456-07:00")).toBe("2026-10-30T12:00:00.123456Z");
    expect(monitorTimestamp.parse("2026-10-30T12:00:00.000+00:00")).toBe("2026-10-30T12:00:00Z");
    for (const timestamp of ["2026-10-30T12:00:00Z", "2026-10-30T05:00:00-07:00", "2026-10-30T12:00:00+00:00"]) {
      for (const event_type of ["completion", "error"]) expect(eventSchema.parse({ event_type, timestamp, error_message: "quota" })).toMatchObject({ timestamp: "2026-10-30T12:00:00Z" });
    }
  });
  it("passes selected frequency to create and updates only that field on the existing monitor", async () => {
    vi.stubEnv("PARALLEL_API_KEY", "test");
    const fetcher = vi.fn(async () => Response.json({ monitor_id: "monitor-id", status: "active", frequency: "6h" }));
    vi.stubGlobal("fetch", fetcher);
    await parallelMonitors.create("Public releases", "watch-id", "https://bell.example.com", "6h");
    await parallelMonitors.update("monitor-id", "6h");
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(calls[0][1].body as string).frequency).toBe("6h");
    expect(calls[1][0]).toBe("https://api.parallel.ai/v1/monitors/monitor-id/update");
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ frequency: "6h" });
  });
  it.each([
    ["monitor.event.detected", { event_group_id: "group-1" }],
    ["monitor.execution.completed", { type: "completion", monitor_ts: "completed_2026-10-30T12:00:00Z" }],
    ["monitor.execution.failed", { type: "error", error: "Execution failed", id: "error-1", date: "2026-10-30T12:00:00Z" }],
  ])("accepts a signed Parallel %s callback", async (type, event) => {
    const secret = `whsec_${Buffer.alloc(32, 3).toString("base64")}`;
    vi.stubEnv("PARALLEL_WEBHOOK_SECRET", secret);
    const pool = new Pool();
    const store = new MonitorStore(pool);
    const transaction = vi.spyOn(store, "transaction").mockResolvedValue(undefined);
    const service = new MonitorService(store);
    const now = new Date();
    const body = JSON.stringify({ type, timestamp: now.toISOString().replace("Z", "+00:00"), data: { monitor_id: "monitor-1", event, metadata: {} } });
    const headers = { "webhook-id": "callback-1", "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": new Webhook(secret).sign("callback-1", now, body) };
    try {
      expect((await receiveWebhook(new Request("https://bell.example/webhook", { method: "POST", headers, body }), () => service)).status).toBe(204);
      expect(transaction).toHaveBeenCalledOnce();
    } finally { await pool.end(); }
  });
  it("handles idle database errors without exposing connection details", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://unused");
    const pool = monitorStore().pool;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => pool.emit("error", new Error("sensitive connection details"))).not.toThrow();
      expect(log).toHaveBeenCalledWith("Monitor database connection failed.");
    } finally { await pool.end(); }
  });
  it("authenticates both scheduler methods and fails closed without a secret", async () => {
    const process = vi.fn(async () => ({ processed: 1 }));
    const service = () => ({ process }) as unknown as MonitorService;
    const request = (method: string, token: string) => new Request("https://bell.example/process", { method, headers: { Authorization: `Bearer ${token}` } });
    expect((await processMonitors(request("GET", "undefined"), service)).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "secret");
    expect((await processMonitors(request("POST", "wrong"), service)).status).toBe(401);
    for (const method of ["GET", "POST"]) {
      const response = await processMonitors(request(method, "secret"), service);
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(process).toHaveBeenCalledTimes(2);
  });
  it("does not acknowledge failed persistence, invalid signatures, or oversized callbacks", async () => {
    vi.stubEnv("PARALLEL_WEBHOOK_SECRET", "test");
    const ingest = vi.fn(async () => { throw new Error("database unavailable"); });
    const service = () => ({ ingest }) as unknown as MonitorService;
    const request = (body = "{}") => new Request("https://bell.example/webhook", { method: "POST", body });
    expect((await receiveWebhook(request(), service)).status).toBe(503);
    ingest.mockRejectedValueOnce(new WebhookVerificationError("invalid"));
    expect((await receiveWebhook(request(), service)).status).toBe(401);
    expect((await receiveWebhook(request("x".repeat(70_000)), service)).status).not.toBe(204);
    expect(ingest).toHaveBeenCalledTimes(2);
  });
  it("accepts a valid signature among multiple signatures", () => {
    const verifier = new Webhook(`whsec_${Buffer.alloc(32, 3).toString("base64")}`);
    const now = new Date(), body = '{"test":true}';
    expect(verifier.verify(body, { "webhook-id": "id", "webhook-timestamp": String(Math.floor(now.getTime()/1000)), "webhook-signature": `v1,invalid ${verifier.sign("id", now, body)}` })).toEqual({ test: true });
  });
  it("rejects web identities and requires trusted destination attributes", () => {
    const context = (auth: unknown) => ({ session: { auth: { current: auth } } }) as ToolContext;
    expect(() => watchIdentity(context({ authenticator: "basic", principalType: "user", principalId: "linq:fake", issuer: "linq" }))).toThrow();
    expect(() => watchDestination(context({ authenticator: "linq-message", principalType: "user", principalId: "linq:real", issuer: "linq", attributes: {} }))).toThrow();
  });
  it("uses the v1 create contract and passes stable Linq idempotency in the message body", async () => {
    vi.stubEnv("PARALLEL_API_KEY", "parallel-test"); vi.stubEnv("LINQ_API_KEY", "linq-test");
    const fetcher = vi.fn(async (url: string) => Response.json(url.includes("parallel.ai") ? { monitor_id: "monitor-id", status: "active", frequency: "1d" } : { message: { id: "message-id" } }));
    vi.stubGlobal("fetch", fetcher);
    await parallelMonitors.create("Public releases", "watch-id", "https://bell.example.com");
    expect(fetcher).toHaveBeenCalledWith("https://api.parallel.ai/v1/monitors", expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ "x-api-key": "parallel-test" }), body: expect.any(String) }));
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({ type: "event_stream", frequency: "1d", processor: "lite", settings: { include_backfill: false }, metadata: { bell_watch_id: "watch-id" } });
    await sendLinq({ chat: "chat-id", sender: "+12025550123", line: "+12025550100" }, "text", "stable");
    expect(JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ message: { parts: [{ type: "text", value: "text" }], idempotency_key: "stable" } });
  });
  it("bounds response reads and exposes retry delay without leaking error bodies", async () => {
    await expect(readBounded(new Response("too long"), 3)).rejects.toThrow("size limit");
    vi.stubEnv("PARALLEL_API_KEY", "test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret provider detail", { status: 429, headers: { "Retry-After": "60" } })));
    await expect(parallelMonitors.list()).rejects.toMatchObject({ status: 429, retryAfter: 60_000 });
    await expect(parallelMonitors.list()).rejects.toBeInstanceOf(ProviderError);
  });
});
