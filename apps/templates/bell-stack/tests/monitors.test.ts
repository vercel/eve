import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import { MonitorService } from "../server/monitors/service";
import { MonitorStore } from "../server/monitors/store";
import { type Destination, type Owner } from "../server/monitors/config";
import { type MonitorProvider, ProviderError } from "../server/monitors/provider";

const databaseUrl = process.env.TEST_MONITOR_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_MONITOR_DATABASE_URL is required in CI");
const owner: Owner = { issuer: "linq", id: "linq:sender" };
const destination: Destination = { chat: "chat-1", sender: "+12025550123", line: "+12025550100" };
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const detected = { event_type: "event_stream", event_id: "event-1", event_group_id: "group-1", event_date: "2026-10-30", output: { type: "text", content: "A new public release.", basis: [{ citations: [{ url: "https://example.com/release" }] }] } };

describe.skipIf(!databaseUrl)("Persistent Parallel watches", () => {
  const schema = `monitor_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, store: MonitorStore, service: MonitorService;
  let provider: MonitorProvider;
  let send: ReturnType<typeof vi.fn<(destination: Destination, text: string, key: string) => Promise<string>>>;
  let remote: { monitor_id: string; status: string; frequency: string; metadata: { bell_watch_id: string } }[];
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
    await pool.query(await readFile(new URL("../migrations/004_parallel_monitors.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../migrations/005_monitor_frequency.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE bell_monitor_jobs, bell_monitor_events, bell_monitor_inbox, bell_monitors CASCADE");
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    vi.stubEnv("PARALLEL_API_KEY", "test");
    vi.stubEnv("PARALLEL_WEBHOOK_SECRET", secret);
    vi.stubEnv("CRON_SECRET", "worker-secret");
    vi.stubEnv("LINQ_API_KEY", "test");
    vi.stubEnv("BELL_PUBLIC_URL", "https://bell.example.com");
    vi.stubEnv("BELL_LINQ_PHONE_NUMBER", destination.line);
    vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", destination.sender);
    remote = [];
    provider = {
      create: vi.fn(async (_query, id, _origin, frequency = "1d") => {
        const result = { monitor_id: `monitor-${id}`, status: "active", frequency, metadata: { bell_watch_id: id } };
        remote.push(result); return result;
      }),
      list: vi.fn(async () => ({ monitors: remote, next_cursor: null })),
      events: vi.fn(async () => ({ events: [detected], next_cursor: null })),
      update: vi.fn(async (id, frequency) => {
        const monitor = remote.find(m => m.monitor_id === id)!;
        monitor.frequency = frequency;
        return { ...monitor };
      }),
      cancel: vi.fn(async id => { remote.find(m => m.monitor_id === id)!.status = "cancelled"; }),
    };
    send = vi.fn(async () => "accepted-message");
    store = new MonitorStore(pool);
    service = new MonitorService(store, provider, send);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  const create = (operation = "session/call") => service.create(owner, destination, operation, "Watch public product releases");
  const listed = async () => (await service.list(owner)).watches;
  async function callback(id: string, webhookId = randomUUID()) {
    const body = JSON.stringify({ type: "monitor.event.detected", timestamp: new Date().toISOString(), data: { monitor_id: `monitor-${id}`, event: { event_group_id: "group-1" }, metadata: { bell_watch_id: id } } });
    const timestamp = new Date();
    return service.ingest(body, { "webhook-id": webhookId, "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "webhook-signature": new Webhook(secret).sign(webhookId, timestamp, body) });
  }
  it("upgrades existing daily watches without resetting their state", async () => {
    const legacySchema = `${schema}_legacy`;
    await admin.query(`CREATE SCHEMA ${legacySchema}`);
    const legacy = new Pool({ connectionString: databaseUrl, options: `-c search_path=${legacySchema}` });
    try {
      await legacy.query(await readFile(new URL("../migrations/004_parallel_monitors.sql", import.meta.url), "utf8"));
      await legacy.query("INSERT INTO bell_monitors(id,issuer,owner_id,operation,query,destination,status) VALUES($1,'linq','linq:sender','call','query',$2,'active')", [randomUUID(), destination]);
      const migration = await readFile(new URL("../migrations/005_monitor_frequency.sql", import.meta.url), "utf8");
      await legacy.query(migration); await legacy.query(migration);
      expect((await legacy.query("SELECT status,frequency,creation_frequency,pending_frequency FROM bell_monitors")).rows).toEqual([{ status: "active", frequency: "1d", creation_frequency: "1d", pending_frequency: null }]);
    } finally { await legacy.end(); await admin.query(`DROP SCHEMA ${legacySchema} CASCADE`); }
  });
  it("defaults to daily and preserves an explicit frequency through creation and listing", async () => {
    expect(await create()).toMatchObject({ frequency: "1d" });
    const watch = await service.create(owner, destination, "six-hour", "Public releases", "6h");
    expect(watch.frequency).toBe("6h");
    expect(remote.find(m => m.monitor_id === `monitor-${watch.id}`)?.frequency).toBe("6h");
    expect((await listed()).find(w => w.id === watch.id)?.frequency).toBe("6h");
    await expect(service.create(owner, destination, "six-hour", "Public releases", "1d")).rejects.toThrow("different input");
  });
  it("keeps creation replay stable after a confirmed frequency change", async () => {
    const watch = await create();
    expect(await service.update(owner, watch.id, "6h")).toMatchObject({ frequency: "1d", pending_frequency: "6h" });
    expect((await listed())[0]).toMatchObject({ frequency: "1d", pending_frequency: "6h" });
    await new MonitorService(new MonitorStore(pool), provider, send).process();
    expect(await create()).toMatchObject({ frequency: "6h", pending_frequency: null });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.update).toHaveBeenCalledWith(`monitor-${watch.id}`, "6h");
    expect(await service.update(owner, watch.id, "6h")).toMatchObject({ pending_frequency: null });
    await service.process();
    expect(provider.update).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite a confirmed cadence with a delayed creation response", async () => {
    const watch = await create();
    await service.update(owner, watch.id, "6h"); await service.process();
    await store.bind(watch.id, `monitor-${watch.id}`, false, "1d");
    expect((await store.get(watch.id)).frequency).toBe("6h");
  });
  it("rejects invalid cadence before creating or changing a watch", async () => {
    await expect(service.create(owner, destination, "bad", "Public releases", "5m")).rejects.toThrow();
    expect(provider.create).not.toHaveBeenCalled();
    const watch = await create();
    await expect(service.update(owner, watch.id, "31d")).rejects.toThrow();
    expect((await pool.query("SELECT * FROM bell_monitor_jobs WHERE kind='update'")).rowCount).toBe(0);
    const prepared = await store.prepare(owner, destination, "not-active", "Public releases");
    await expect(service.update(owner, prepared.id, "6h")).rejects.toThrow("active watch");
  });
  it("scopes updates to their owner and permits only one pending change", async () => {
    const watch = await create();
    await expect(service.update({ issuer: "linq", id: "linq:other" }, watch.id, "6h")).rejects.toThrow("Watch not found");
    await Promise.all([service.update(owner, watch.id, "7d"), service.update(owner, watch.id, "1w")]);
    expect((await pool.query("SELECT * FROM bell_monitor_jobs WHERE kind='update'")).rowCount).toBe(1);
    await expect(service.update(owner, watch.id, "6h")).rejects.toThrow("pending frequency change");
    await service.stop(owner, watch.id);
    await service.process();
    expect(provider.update).not.toHaveBeenCalled();
    await expect(service.update(owner, watch.id, "6h")).rejects.toThrow("active watch");
  });
  it("retries a lost update response after restart without claiming premature success", async () => {
    const watch = await create();
    const update = provider.update;
    provider.update = vi.fn(async (id, frequency) => { await update(id, frequency); throw new Error("response lost"); });
    await service.update(owner, watch.id, "6h");
    await service.process();
    expect((await listed())[0]).toMatchObject({ frequency: "1d", pending_frequency: "6h", problems: [expect.objectContaining({ kind: "update" })] });
    provider.update = update;
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now() WHERE kind='update'");
    await new MonitorService(new MonitorStore(pool), provider, send).process();
    expect((await listed())[0]).toMatchObject({ frequency: "6h", pending_frequency: null });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it("retains a failed update for repair and rejects an unconfirmed response", async () => {
    const watch = await create();
    provider.update = vi.fn(async id => ({ ...remote[0], monitor_id: id, frequency: "1d" }));
    await service.update(owner, watch.id, "6h"); await service.process();
    expect((await store.get(watch.id)).pending_frequency).toBe("6h");
    provider.update = vi.fn(async () => { throw new ProviderError(403); });
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now() WHERE kind='update'");
    await service.process();
    expect((await listed())[0]).toMatchObject({ frequency: "1d", pending_frequency: "6h", problems: [expect.objectContaining({ kind: "update", failed: true, error: "provider_http_403" })] });
    await service.stop(owner, watch.id);
    expect((await store.get(watch.id)).pending_frequency).toBeNull();
  });
  it("suppresses a claimed update after stop commits", async () => {
    const watch = await create();
    await service.update(owner, watch.id, "6h");
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async id => {
      const snapshot = await get(id);
      await new MonitorStore(pool).stop(owner, id);
      return snapshot;
    });
    await service.process();
    expect(provider.update).not.toHaveBeenCalled();
    expect((await get(watch.id)).pending_frequency).toBeNull();
  });
  it("cancels after an in-flight update completes", async () => {
    const watch = await create();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const update = provider.update;
    provider.update = vi.fn(async (id, frequency) => { await gate; return update(id, frequency); });
    await service.update(owner, watch.id, "6h");
    const processing = service.process();
    let stopping: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(provider.update).toHaveBeenCalledOnce());
      stopping = new MonitorStore(pool).stop(owner, watch.id);
      await vi.waitFor(async () => expect((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%owner_id=$3 FOR UPDATE%' ")).rowCount).toBeGreaterThan(0));
    } finally { release(); await Promise.all([processing, stopping]); }
    await service.process();
    expect(remote[0]).toMatchObject({ status: "cancelled", frequency: "6h" });
    expect((await store.get(watch.id)).pending_frequency).toBeNull();
  });
  it("processes valid records while surfacing a malformed record as incomplete recovery", async () => {
    await create();
    provider.events = vi.fn(async () => ({ events: [detected, { event_type: "completion", timestamp: "invalid" }] }));
    await service.process();
    expect(send).toHaveBeenCalledOnce();
    expect((await listed())[0]).toMatchObject({ recovery_gap: true, last_scan_at: null, problems: [expect.objectContaining({ kind: "sync", error: "invalid_monitor_event" })] });
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now() WHERE kind='sync'");
    await service.process();
    expect(send).toHaveBeenCalledOnce();
  });
  it("deduplicates concurrent creation, scopes ownership, and rejects changed replay input", async () => {
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.id).toBe(b.id);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(await service.list({ issuer: "linq", id: "linq:other" })).toMatchObject({ watches: [], next_cursor: null });
    await expect(service.stop({ issuer: "linq", id: "linq:other" }, a.id)).rejects.toThrow("Watch not found");
    await expect(service.create(owner, destination, "session/call", "Changed query")).rejects.toThrow("different input");
  });
  it("reconciles an accepted creation with a lost response without another create", async () => {
    const original = provider.create;
    provider.create = vi.fn(async (query, id, origin) => { await original(query, id, origin); throw new Error("response lost"); });
    const watch = await create();
    expect(watch.status).toBe("uncertain");
    await create();
    await service.process();
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect((await listed())[0].status).toBe("active");
  });
  it("delivers a signed event after service replacement without an Eve session, once across workers", async () => {
    const watch = await create();
    const webhookId = randomUUID();
    await callback(watch.id, webhookId);
    await callback(watch.id, webhookId);
    service = new MonitorService(new MonitorStore(pool), provider, send);
    await Promise.all([service.process(), service.process()]);
    await service.process();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(destination);
    expect(send.mock.calls[0][1]).toContain("https://example.com/release");
    expect((await listed())[0].updates).toHaveLength(1);
  });
  it("reuses frozen delivery and key after an accepted send loses its response", async () => {
    const watch = await create(); await callback(watch.id);
    send.mockRejectedValueOnce(new Error("response lost"));
    await service.process();
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now() WHERE kind='send'");
    await service.process();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  });
  it("stops queued deliveries and cancels without webhook or messaging configuration", async () => {
    const watch = await create(); await callback(watch.id);
    vi.stubEnv("LINQ_API_KEY", ""); vi.stubEnv("PARALLEL_WEBHOOK_SECRET", "");
    await service.stop(owner, watch.id); await service.process();
    expect(send).not.toHaveBeenCalled();
    expect(provider.cancel).toHaveBeenCalledWith(`monitor-${watch.id}`);
    expect((await listed())[0].status).toBe("cancelled");
  });
  it("suppresses a claimed send when stop commits after the worker reads the watch", async () => {
    const watch = await create();
    await pool.query("UPDATE bell_monitors SET next_scan_at=now()+interval '1 hour'");
    await pool.query("DELETE FROM bell_monitor_jobs");
    await store.enqueue("send", "queued-send", watch.id, { text: "update", key: "stable", eventId: "event-1" });
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async id => {
      const snapshot = await get(id);
      await new MonitorService(new MonitorStore(pool), provider, send).stop(owner, id);
      return snapshot;
    });
    await service.process();
    expect(send).not.toHaveBeenCalled();
    expect((await get(watch.id)).stopped).toBe(true);
  });
  it("waits for an in-flight send before confirming stop", async () => {
    const watch = await create();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    send.mockImplementationOnce(async () => { await gate; return "accepted-message"; });
    const processing = service.process();
    let stopping: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      stopping = new MonitorStore(pool).stop(owner, watch.id);
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%owner_id=$3 FOR UPDATE%'");
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      expect((await store.get(watch.id)).stopped).toBe(false);
    } finally {
      release();
      await Promise.all([processing, stopping]);
    }
    expect((await store.get(watch.id)).stopped).toBe(true);
    await service.process();
    expect(send).toHaveBeenCalledOnce();
  });
  it.each([
    ["monitor.execution.completed", { type: "completion", monitor_ts: "completed_2026-10-30T12:00:00Z" }, "completed"],
    ["monitor.execution.failed", { type: "error", error: "Execution failed", id: "error-1", date: "2026-10-30T12:00:00Z" }, "failed"],
  ])("stores and processes a signed %s without sending an alert", async (type, event, health) => {
    const watch = await create();
    provider.events = vi.fn(async () => ({ events: [] }));
    const now = new Date(), id = randomUUID();
    const body = JSON.stringify({ type, timestamp: now.toISOString().replace("Z", "+00:00"), data: { monitor_id: `monitor-${watch.id}`, event } });
    await service.ingest(body, { "webhook-id": id, "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": new Webhook(secret).sign(id, now, body) });
    expect((await pool.query("SELECT id FROM bell_monitor_inbox WHERE id=$1", [id])).rowCount).toBe(1);
    await service.process();
    expect((await store.get(watch.id)).health).toBe(health);
    expect(send).not.toHaveBeenCalled();
  });
  it("suppresses delivery when the sender is removed from the allowlist", async () => {
    const watch = await create(); await callback(watch.id);
    vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", "");
    await service.process();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects forged and stale signatures without durable ingestion", async () => {
    await expect(service.ingest("{}", { "webhook-id": "fake", "webhook-timestamp": "0", "webhook-signature": "v1,fake" })).rejects.toThrow();
    const date = new Date(Date.now() - 600_000), body = "{}";
    await expect(service.ingest(body, { "webhook-id": "old", "webhook-timestamp": String(Math.floor(date.getTime()/1000)), "webhook-signature": new Webhook(secret).sign("old", date, body) })).rejects.toThrow();
    expect((await pool.query("SELECT * FROM bell_monitor_inbox")).rowCount).toBe(0);
  });
  it("recovers valid events beside offset timestamps and preserves equivalent scan anchors", async () => {
    const watch = await create();
    await pool.query("UPDATE bell_monitors SET scan_anchor='completion:2026-10-30T12:00:00Z' WHERE id=$1", [watch.id]);
    provider.events = vi.fn(async () => ({ events: [
      { event_type: "completion", timestamp: "2026-10-30T05:00:00-07:00" },
      { event_type: "error", timestamp: "2026-10-29T12:00:00+00:00", error_message: "quota" }, detected,
    ] }));
    await service.process();
    expect(send).toHaveBeenCalledOnce();
    expect((await listed())[0]).toMatchObject({ health: "completed", recovery_gap: false, problems: [] });
  });
  it("records completion and errors without event IDs and does not send health messages", async () => {
    await create();
    provider.events = vi.fn(async () => ({ events: [{ event_type: "completion", timestamp: "2026-10-30T12:00:00Z" }, { event_type: "error", timestamp: "2026-10-29T12:00:00Z", error_message: "quota" }], next_cursor: null }));
    await service.process();
    expect(send).not.toHaveBeenCalled();
    const [watch] = await listed();
    expect(watch.health).toBe("completed");
  });
  it("never redispatches creation after a crash at the dispatch boundary", async () => {
    const watch = await store.prepare(owner, destination, "crashed", "Watch public releases");
    expect(await store.dispatch(watch.id)).toBe(true);
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now()");
    await service.create(owner, destination, "crashed", "Watch public releases");
    await service.process();
    expect(provider.create).not.toHaveBeenCalled();
    expect((await store.get(watch.id)).remote_id).toBeNull();
  });
  it("cancels an uncertain remote creation when stop arrives before reconciliation", async () => {
    const original = provider.create;
    provider.create = vi.fn(async (query, id, origin) => { await original(query, id, origin); throw new Error("lost"); });
    const watch = await create();
    await service.stop(owner, watch.id);
    await service.process();
    expect(remote[0].status).toBe("cancelled");
    expect((await listed())[0].status).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
  });
  it("retains an early callback until remote identity can be verified", async () => {
    const original = provider.create;
    provider.create = vi.fn(async (query, id, origin) => {
      await callback(id);
      await service.process();
      return original(query, id, origin);
    });
    await create();
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now()");
    await service.process();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("resumes an expired delivery lease with the same frozen payload", async () => {
    const watch = await create();
    await callback(watch.id);
    send.mockRejectedValueOnce(new Error("interrupted"));
    await service.process();
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now(),lease_until=now()-interval '1 minute',lease_token=$1 WHERE kind='send'", [randomUUID()]);
    await new MonitorService(new MonitorStore(pool), provider, send).process();
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  });
  it("records local suppression when the provider key is missing", async () => {
    const watch = await create();
    vi.stubEnv("PARALLEL_API_KEY", "");
    provider.cancel = vi.fn(async () => { throw new Error("missing key"); });
    expect((await service.stop(owner, watch.id)).status).toBe("cancel_pending");
    await service.process();
    expect((await store.get(watch.id)).stopped).toBe(true);
    expect((await listed())[0].problems).not.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it("surfaces lost history and handles overlapping pages without duplicate sends", async () => {
    const watch = await create();
    await service.process();
    await pool.query("UPDATE bell_monitors SET next_scan_at=now() WHERE id=$1", [watch.id]);
    const newer = { ...detected, event_id: "event-2", event_group_id: "group-2" };
    provider.events = vi.fn(async (_id, _group, cursor) => cursor ? { events: [newer], next_cursor: null } : { events: [newer], next_cursor: "page-2" });
    await service.process();
    expect(send).toHaveBeenCalledTimes(2);
    expect((await listed())[0].recovery_gap).toBe(true);
  });
  it("resumes a recovery scan stopped by the work budget without refetching pages or resending events", async () => {
    const watch = await create();
    await service.process();
    expect(send).toHaveBeenCalledTimes(1);
    const page = (id: number, next: string | null) => ({ events: [{ ...detected, event_id: `event-${id}`, event_group_id: `group-${id}` }], next_cursor: next });
    const pages: Record<string, { events: unknown[]; next_cursor: string | null }> = {
      start: page(2, "cursor-2"), "cursor-2": page(3, "cursor-3"), "cursor-3": page(4, "cursor-4"),
      // The oldest page overlaps the previous scan's anchor, so coverage is complete and event-1 must not be resent.
      "cursor-4": { events: [{ ...detected, event_id: "event-5", event_group_id: "group-5" }, detected], next_cursor: null },
    };
    const fetched: string[] = [];
    provider.events = vi.fn(async (_id, _group, cursor) => {
      fetched.push(cursor ?? "start");
      await new Promise(resolve => setTimeout(resolve, 80));
      return pages[cursor ?? "start"];
    });
    await pool.query("UPDATE bell_monitors SET next_scan_at=now() WHERE id=$1", [watch.id]);
    // A work budget smaller than one page leaves each run able to fetch a single page, as a slow recovery does against the real 20 seconds.
    const slow = new MonitorService(store, provider, send, 50);
    const saved: unknown[] = [];
    for (let run = 0; run < 10; run++) {
      await slow.process();
      const job = (await pool.query<{ attempts: number; failed: boolean; last_error: string | null; payload: { cursor?: string } }>("SELECT attempts,failed,last_error,payload FROM bell_monitor_jobs WHERE id=$1", [`sync:${watch.id}`])).rows[0];
      if (!job) break;
      expect(job).toMatchObject({ attempts: 0, failed: false, last_error: null });
      saved.push(job.payload.cursor);
    }
    expect(saved).toEqual(["cursor-2", "cursor-3", "cursor-4"]);
    expect(fetched).toEqual(["start", "cursor-2", "cursor-3", "cursor-4"]);
    await service.process();
    const [listedWatch] = await listed();
    expect(listedWatch).toMatchObject({ recovery_gap: false, problems: [] });
    expect(listedWatch.last_scan_at).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(5);
    expect(new Set(send.mock.calls.map(call => call[2])).size).toBe(5);
  });
  it("keeps a budget-limited recovery scan alive past the eight-attempt limit", async () => {
    const watch = await create();
    await service.process();
    provider.events = vi.fn(async (_id, _group, cursor) => {
      const read = cursor ? Number(cursor.slice("cursor-".length)) : 1;
      await new Promise(resolve => setTimeout(resolve, 80));
      if (read > 11) return { events: [detected], next_cursor: null };
      return { events: [{ ...detected, event_id: `event-${read}`, event_group_id: `group-${read}` }], next_cursor: `cursor-${read + 1}` };
    });
    await pool.query("UPDATE bell_monitors SET next_scan_at=now() WHERE id=$1", [watch.id]);
    // Twelve pages at one page per budget-limited run take more runs than the eight attempts that used to mark the job failed.
    const slow = new MonitorService(store, provider, send, 50);
    let runs = 0;
    for (; runs < 20; runs++) {
      await slow.process();
      const job = (await pool.query<{ attempts: number; failed: boolean }>("SELECT attempts,failed FROM bell_monitor_jobs WHERE id=$1", [`sync:${watch.id}`])).rows[0];
      if (!job) break;
      expect(job).toMatchObject({ attempts: 0, failed: false });
    }
    expect(runs).toBeGreaterThan(8);
    await service.process();
    expect((await listed())[0]).toMatchObject({ recovery_gap: false, problems: [] });
    expect(new Set(send.mock.calls.map(call => call[2])).size).toBe(send.mock.calls.length);
  });
  it("restarts a recovery scan that already exhausted its attempts on the next scheduled check", async () => {
    const watch = await create();
    await service.process();
    await pool.query("UPDATE bell_monitors SET next_scan_at=now() WHERE id=$1", [watch.id]);
    provider.events = vi.fn(async () => { throw new Error("recovery unavailable"); });
    for (let attempt = 0; attempt < 8; attempt++) {
      await service.process();
      await pool.query("UPDATE bell_monitor_jobs SET next_at=now() WHERE id=$1", [`sync:${watch.id}`]);
    }
    expect((await pool.query<{ failed: boolean }>("SELECT failed FROM bell_monitor_jobs WHERE id=$1", [`sync:${watch.id}`])).rows[0]).toMatchObject({ failed: true });
    provider.events = vi.fn(async () => ({ events: [detected], next_cursor: null }));
    await service.process();
    expect(provider.events).not.toHaveBeenCalled();
    await pool.query("UPDATE bell_monitors SET next_scan_at=now() WHERE id=$1", [watch.id]);
    await service.process();
    expect(provider.events).toHaveBeenCalled();
    expect((await pool.query("SELECT 1 FROM bell_monitor_jobs WHERE id=$1", [`sync:${watch.id}`])).rowCount).toBe(0);
    expect((await listed())[0].last_scan_at).not.toBeNull();
  });
  it.each(["malformed record", "resume limit"])("recovers after a saved scan fails on its %s", async failure => {
    const watch = await create();
    let clock = Date.now(), repaired = false;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const lastPage = failure === "malformed record" ? 3 : 63;
    provider.events = vi.fn(async (_id, _group, cursor) => {
      clock += repaired && failure === "malformed record" ? 1 : 7_000;
      const page = Number(cursor ?? 0);
      const events: unknown[] = [{ event_type: "completion", timestamp: new Date(Date.UTC(2026, 9, 30) - page * 3_600_000).toISOString() }];
      if (failure === "malformed record" && !page) events.push(repaired ? detected : { event_type: "completion", timestamp: "invalid" });
      if (failure === "resume limit" && page === lastPage) events.push(detected);
      return { events, next_cursor: page < lastPage ? String(page + 1) : null };
    });
    let failed = false;
    for (let run = 0; run < 28; run++) {
      await service.process();
      failed = (await pool.query("SELECT failed FROM bell_monitor_jobs WHERE id=$1", [`sync:${watch.id}`])).rows[0]?.failed === true;
      if (failed) break;
      await pool.query("UPDATE bell_monitor_jobs SET next_at=now() WHERE id=$1", [`sync:${watch.id}`]);
    }
    expect(failed).toBe(true);
    repaired = true;
    await pool.query("UPDATE bell_monitors SET next_scan_at=now() WHERE id=$1", [watch.id]);
    for (let run = 0; run < 3; run++) await new MonitorService(new MonitorStore(pool), provider, send).process();
    expect((await pool.query("SELECT 1 FROM bell_monitor_jobs WHERE id=$1", [`sync:${watch.id}`])).rowCount).toBe(0);
    expect((await store.get(watch.id)).last_scan_at).not.toBeNull();
    expect(send).toHaveBeenCalledOnce();
  });
  it("keeps an active watch reachable behind newer cancelled watches and pages the rest", async () => {
    const active = await create();
    for (let index = 0; index < 50; index++) {
      await pool.query(`INSERT INTO bell_monitors(id,issuer,owner_id,operation,query,destination,status,creation_frequency,frequency,created_at)
        VALUES($1,$2,$3,$4,'Cancelled watch',$5,'cancelled','1d','1d',now()+($6||' seconds')::interval)`, [randomUUID(), owner.issuer, owner.id, `cancelled-${index}`, destination, index + 1]);
    }
    const first = await service.list(owner);
    expect(first.watches).toHaveLength(50);
    expect(first.watches[0].id).toBe(active.id);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await service.list(owner, { cursor: first.next_cursor! });
    expect(second.watches).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.watches, ...second.watches].map(w => w.id)).size).toBe(51);
    expect(await service.list(owner, { status: "open" })).toMatchObject({ watches: [expect.objectContaining({ id: active.id })], next_cursor: null });
    const closed = await service.list(owner, { status: "closed" });
    expect(closed.watches).toHaveLength(50);
    expect(closed.watches.every(w => w.status === "cancelled")).toBe(true);
    expect(closed.next_cursor).toBeNull();
    await expect(service.list(owner, { cursor: "not-a-cursor" })).rejects.toThrow("page cursor");
    await expect(service.list(owner, { status: "retired" })).rejects.toThrow();
  });
  it.each(["2026-10-31T12:00:00.123000Z", "2026-10-31T12:00:00.123456Z"])("pages every watch sharing timestamp %s", async timestamp => {
    await pool.query(`INSERT INTO bell_monitors(id,issuer,owner_id,operation,query,destination,status,created_at)
      SELECT gen_random_uuid(),$1,$2,'page-'||i,'Public releases',$3,'active',$4::timestamptz FROM generate_series(1,51) i`, [owner.issuer, owner.id, destination, timestamp]);
    const first = await service.list(owner);
    expect(first.watches).toHaveLength(50);
    expect(first.next_cursor).not.toBeNull();
    const second = await service.list(owner, { cursor: first.next_cursor! });
    expect(second.watches).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.watches, ...second.watches].map(w => w.id)).size).toBe(51);
  });
  it("keeps valid citations when another URL is unsafe", async () => {
    await create();
    provider.events = vi.fn(async () => ({ events: [{ ...detected, output: { ...detected.output, basis: [{ citations: [{ url: "http://localhost/private" }, { url: "https://example.com/release" }] }] } }], next_cursor: null }));
    await service.process();
    expect(send.mock.calls[0][1]).toContain("https://example.com/release");
    expect(send.mock.calls[0][1]).not.toContain("localhost");
  });
  it("does not adopt an unrelated account callback", async () => {
    await callback(randomUUID());
    await service.process();
    expect(provider.events).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

});
