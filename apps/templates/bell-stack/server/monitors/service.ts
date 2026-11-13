import { createHash } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import {
  allowed,
  assertOwner,
  creationOrigin,
  destinationSchema,
  type Destination,
  type Owner,
  queryInput,
  required,
  frequencyInput,
  monitorTimestamp,
} from "./config";
import {
  eventSchema,
  type MonitorProvider,
  parallelMonitors,
  ProviderError,
  sendLinq,
} from "./provider";
import { type Job, type Watch, MonitorStore, monitorStore, watchFilter } from "./store";

const callbackTimestamp = monitorTimestamp;
class InvalidMonitorEvent extends Error {}
const callbackData = z.object({
  monitor_id: z.string(),
  metadata: z.record(z.string(), z.string()).nullish(),
});
const callbackSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("monitor.event.detected"),
    timestamp: callbackTimestamp,
    data: callbackData.extend({ event: z.object({ event_group_id: z.string() }) }),
  }),
  z.object({
    type: z.literal("monitor.execution.completed"),
    timestamp: callbackTimestamp,
    data: callbackData.extend({
      event: z.object({ type: z.literal("completion"), monitor_ts: z.string() }),
    }),
  }),
  z.object({
    type: z.literal("monitor.execution.failed"),
    timestamp: callbackTimestamp,
    data: callbackData.extend({
      event: z.object({
        type: z.literal("error"),
        error: z.string(),
        id: z.string(),
        date: callbackTimestamp,
      }),
    }),
  }),
]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Saved place of a recovery scan, so a run stopped by the work budget resumes instead of refetching from the newest page.
const syncProgress = z.object({
  group: z.string().optional(),
  cursor: z.string().optional(),
  started: z.string().datetime().optional(),
  anchor: z.string().optional(),
  anchor_seen: z.boolean().default(false),
  runs: z.array(z.string()).default([]),
  invalid: z.boolean().default(false),
  resumes: z.number().int().min(0).default(0),
});
const resumeLimit = 20;
export class MonitorService {
  constructor(
    readonly store: MonitorStore,
    readonly provider: MonitorProvider = parallelMonitors,
    readonly send: (
      destination: Destination,
      text: string,
      key: string,
    ) => Promise<string> = sendLinq,
    readonly budget = 20_000,
  ) {}
  async create(
    owner: Owner,
    destination: Destination,
    operation: string,
    input: string,
    cadence = "1d",
  ) {
    assertOwner(owner);
    destinationSchema.parse(destination);
    if (!allowed(destination)) throw new Error("This Linq destination is no longer allowed.");
    const origin = creationOrigin(),
      query = queryInput.parse(input),
      frequency = frequencyInput.parse(cadence);
    const watch = await this.store.prepare(owner, destination, operation, query, frequency);
    if (await this.store.dispatch(watch.id)) {
      try {
        const remote = await this.provider.create(query, watch.id, origin, frequency);
        await this.store.bind(
          watch.id,
          remote.monitor_id,
          remote.status === "cancelled",
          remote.frequency,
        );
      } catch (error) {
        const rejected =
          error instanceof ProviderError && [400, 401, 403, 422].includes(error.status);
        await this.store.pool.query(
          "UPDATE bell_monitors SET status=$2 WHERE id=$1 AND status='dispatched'",
          [watch.id, rejected ? "failed" : "uncertain"],
        );
        await this.store.pool.query("UPDATE bell_monitor_jobs SET next_at=now() WHERE id=$1", [
          `reconcile:${watch.id}`,
        ]);
      }
    }
    const result = await this.store.get(watch.id);
    return {
      id: result.id,
      status: result.status,
      frequency: result.frequency,
      pending_frequency: result.pending_frequency,
      processor: "lite",
    };
  }
  async list(owner: Owner, options: { status?: string; cursor?: string } = {}) {
    assertOwner(owner);
    const status = watchFilter.parse(options.status ?? "all");
    const page = await this.store.list(owner, status, options.cursor);
    let remaining = 12_000;
    const watches = page.watches.map((w) => {
      const updates: unknown[] = [];
      for (const raw of w.updates) {
        if (remaining <= 0) break;
        const event = eventSchema.parse(raw);
        if (event.event_type !== "event_stream") continue;
        const text =
          typeof event.output.content === "string"
            ? event.output.content
            : JSON.stringify(event.output.content);
        const content = text.slice(0, Math.min(600, remaining));
        remaining -= content.length;
        const citations: string[] = [];
        for (const url of [
          ...new Set(
            event.output.basis.flatMap((b) => b.citations.flatMap((c) => (c.url ? [c.url] : []))),
          ),
        ].slice(0, 3)) {
          if (url.length <= remaining) {
            citations.push(url);
            remaining -= url.length;
          }
        }
        updates.push({
          event_id: event.event_id,
          event_date: event.event_date,
          content,
          citations,
          truncated: content.length < text.length,
        });
      }
      return {
        id: w.id,
        query: w.query.slice(0, 400),
        status: w.status,
        frequency: w.frequency,
        pending_frequency: w.pending_frequency,
        health: w.health,
        health_at: w.health_at,
        recovery_gap: w.recovery_gap,
        last_scan_at: w.last_scan_at,
        updates,
        updates_truncated: updates.length < w.updates.length,
        problems: w.problems,
      };
    });
    return { watches, next_cursor: page.next_cursor };
  }
  async update(owner: Owner, id: string, cadence: string) {
    assertOwner(owner);
    z.string().uuid().parse(id);
    const watch = await this.store.requestFrequency(owner, id, frequencyInput.parse(cadence));
    return {
      id: watch.id,
      status: watch.status,
      frequency: watch.frequency,
      pending_frequency: watch.pending_frequency,
    };
  }
  async stop(owner: Owner, id: string) {
    assertOwner(owner);
    z.string().uuid().parse(id);
    await this.store.stop(owner, id);
    return { id, status: (await this.store.get(id)).status };
  }
  async ingest(body: string, headers: Record<string, string>) {
    if (Buffer.byteLength(body) > 65_536) throw new Error("Webhook too large");
    const parsed = new Webhook(required("PARALLEL_WEBHOOK_SECRET")).verify(body, headers);
    const event = callbackSchema.parse(parsed),
      id = headers["webhook-id"];
    if (!id || id.length > 256) throw new Error("Invalid webhook identity");
    await this.store.transaction(async (client) => {
      const inserted = await client.query(
        "INSERT INTO bell_monitor_inbox(id,payload) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id",
        [id, event],
      );
      if (inserted.rowCount) await this.store.enqueue("inbox", `inbox:${id}`, null, { id }, client);
    });
  }
  async process() {
    const deadline = Date.now() + this.budget;
    await this.store.schedule();
    let processed = 0;
    while (processed < 30 && Date.now() < deadline) {
      const job = await this.store.claim();
      if (!job) break;
      try {
        const resume = await this.run(job, deadline);
        if (resume) await this.store.defer(job, resume);
        else await this.store.finish(job);
      } catch (error) {
        const provider = error instanceof ProviderError ? error : undefined;
        const terminal = !!provider && [400, 401, 402, 403, 404, 422].includes(provider.status);
        const delay = Math.max(
          provider?.retryAfter ?? 0,
          Math.min(3_600_000, 1000 * 2 ** job.attempts) + Math.floor(Math.random() * 1000),
        );
        await this.store.retry(
          job,
          provider
            ? `provider_http_${provider.status}`
            : error instanceof InvalidMonitorEvent
              ? "invalid_monitor_event"
              : "processing_failed",
          terminal,
          delay,
        );
        console.warn("bell_monitor_job_failed", {
          kind: job.kind,
          attempt: job.attempts,
          terminal: terminal || job.attempts >= 8,
        });
      }
      processed++;
    }
    return { processed };
  }
  /** Resolves to a saved payload when the work budget ran out mid-scan, so the next run resumes from there. */
  private async run(job: Job, deadline: number): Promise<Record<string, unknown> | undefined> {
    if (job.kind === "inbox") {
      const payload = (
        await this.store.pool.query("SELECT payload FROM bell_monitor_inbox WHERE id=$1", [
          job.payload.id,
        ])
      ).rows[0]?.payload;
      const event = callbackSchema.parse(payload);
      let watch = (
        await this.store.pool.query<Watch>("SELECT * FROM bell_monitors WHERE remote_id=$1", [
          event.data.monitor_id,
        ])
      ).rows[0];
      if (!watch) {
        const id = event.data.metadata?.bell_watch_id;
        if (!id || !z.string().uuid().safeParse(id).success) return;
        watch = (
          await this.store.pool.query<Watch>(
            "SELECT * FROM bell_monitors WHERE id=$1 AND status IN ('dispatched','uncertain','cancel_pending')",
            [id],
          )
        ).rows[0];
        if (!watch) return;
        // Early callbacks wait for API-backed reconciliation; metadata is not ownership proof.
        throw new Error("Monitor identity not reconciled yet");
      }
      await this.store.health(
        watch.id,
        event.type === "monitor.execution.failed" ? "failed" : "completed",
        event.timestamp,
      );
      if (!watch.stopped && watch.status === "active" && event.type === "monitor.event.detected") {
        await this.store.enqueue(
          "sync",
          `group:${watch.id}:${hash(event.data.event.event_group_id)}`,
          watch.id,
          { group: event.data.event.event_group_id },
        );
      }
      return;
    }
    const watch = await this.store.get(job.watch_id!);
    if (job.kind === "reconcile") {
      if (watch.remote_id || ["failed", "cancelled"].includes(watch.status)) return;
      let cursor = typeof job.payload.cursor === "string" ? job.payload.cursor : undefined;
      for (let page = 0; page < 5 && Date.now() < deadline; page++) {
        const result = await this.provider.list(cursor);
        const matches = result.monitors.filter((m) => m.metadata?.bell_watch_id === watch.id);
        if (matches.length > 1)
          throw new Error("Multiple remote matches require operator reconciliation");
        if (matches.length) {
          await this.store.bind(
            watch.id,
            matches[0].monitor_id,
            matches[0].status === "cancelled",
            matches[0].frequency,
          );
          return;
        }
        cursor = result.next_cursor ?? undefined;
        if (!cursor) break;
      }
      await this.store.pool.query(
        "UPDATE bell_monitor_jobs SET payload=$3 WHERE id=$1 AND lease_token=$2",
        [job.id, job.lease_token, cursor ? { cursor } : {}],
      );
      throw new Error("Creation remains uncertain");
    }
    if (job.kind === "cancel") {
      if (!watch.remote_id) throw new Error("Creation unresolved");
      await this.provider.cancel(watch.remote_id);
      await this.store.pool.query("UPDATE bell_monitors SET status='cancelled' WHERE id=$1", [
        watch.id,
      ]);
      return;
    }
    if (watch.stopped || watch.status !== "active") return;
    if (job.kind === "update") {
      const frequency = frequencyInput.parse(job.payload.frequency);
      await this.store.applyFrequency(watch.id, frequency, async (id) => {
        const remote = await this.provider.update(id, frequency);
        if (
          remote.monitor_id !== id ||
          remote.status !== "active" ||
          remote.frequency !== frequency
        )
          throw new Error("Monitor frequency not confirmed");
        return remote.frequency;
      });
      return;
    }
    if (job.kind === "send") {
      const payload = z
        .object({ text: z.string(), key: z.string(), eventId: z.string() })
        .parse(job.payload);
      await this.store.deliver(watch.id, payload.eventId, async (current) => {
        if (!allowed(current.destination)) throw new ProviderError(403);
        return this.send(current.destination, payload.text, payload.key);
      });
      return;
    }
    if (job.kind === "sync") {
      if (!watch.remote_id) throw new Error("Missing remote monitor");
      const saved = syncProgress.parse(job.payload);
      const group = saved.group;
      const started = saved.started ?? new Date().toISOString();
      let cursor = saved.cursor,
        anchor = saved.anchor,
        previousAnchorSeen = saved.anchor_seen,
        invalidEvents = saved.invalid;
      const runs = new Set(saved.runs);
      const prior = watch.scan_anchor?.match(/^(completion|error):(.*)$/);
      const priorTimestamp = prior ? monitorTimestamp.safeParse(prior[2]) : undefined;
      const previousAnchor =
        prior && priorTimestamp?.success ? `${prior[1]}:${priorTimestamp.data}` : watch.scan_anchor;
      // Each claim fetches at least one page, then stops on a page boundary so the saved cursor never splits a page.
      for (let page = 0; page < 10; page++) {
        if (page && Date.now() >= deadline) break;
        const result = await this.provider.events(watch.remote_id, group, cursor);
        const events = result.events.flatMap((raw) => {
          const parsed = eventSchema.safeParse(raw);
          if (parsed.success) return [parsed.data];
          invalidEvents = true;
          return [];
        });
        const ids = events.flatMap((event) =>
          event.event_type === "event_stream" ? [event.event_id] : [],
        );
        const known = new Set(
          (
            await this.store.pool.query<{ event_id: string }>(
              "SELECT event_id FROM bell_monitor_events WHERE watch_id=$1 AND event_id=ANY($2::text[])",
              [watch.id, ids],
            )
          ).rows.map((row) => row.event_id),
        );
        for (const event of events) {
          const identity =
            event.event_type === "event_stream"
              ? event.event_id
              : `${event.event_type}:${event.timestamp}`;
          anchor ??= identity;
          if (identity === previousAnchor) previousAnchorSeen = true;
          if (runs.size < 100)
            runs.add(event.event_type === "event_stream" ? event.event_group_id : identity);
          if (event.event_type !== "event_stream" || !known.has(event.event_id))
            await this.event(watch, event);
        }
        const next = result.next_cursor ?? undefined;
        if (!next) {
          if (invalidEvents) {
            await this.store.pool.query("UPDATE bell_monitors SET recovery_gap=true WHERE id=$1", [
              watch.id,
            ]);
            throw new InvalidMonitorEvent("Invalid monitor event in recovery scan");
          }
          if (!group) {
            const gap = watch.scan_anchor ? !previousAnchorSeen : runs.size >= 100;
            await this.store.pool.query(
              "UPDATE bell_monitors SET last_scan_at=$2,scan_anchor=COALESCE($3,scan_anchor),recovery_gap=recovery_gap OR $4 WHERE id=$1",
              [watch.id, started, anchor ?? null, gap],
            );
          }
          return;
        }
        cursor = next;
      }
      // Only resume while the scan keeps moving forward, so a stalled cursor still surfaces as a gap instead of looping.
      if (cursor && cursor !== saved.cursor && saved.resumes < resumeLimit) {
        return {
          group,
          cursor,
          started,
          anchor,
          anchor_seen: previousAnchorSeen,
          runs: [...runs],
          invalid: invalidEvents,
          resumes: saved.resumes + 1,
        };
      }
      await this.store.pool.query("UPDATE bell_monitors SET recovery_gap=true WHERE id=$1", [
        watch.id,
      ]);
      throw new Error("Recovery scan exceeded work budget");
    }
  }
  private async event(watch: Watch, raw: unknown) {
    const event = eventSchema.parse(raw);
    if (event.event_type !== "event_stream") {
      await this.store.health(
        watch.id,
        event.event_type === "completion" ? "completed" : "failed",
        event.timestamp,
      );
      return;
    }
    const content =
      typeof event.output.content === "string"
        ? event.output.content
        : JSON.stringify(event.output.content);
    const urls = [
      ...new Set(
        event.output.basis.flatMap((b) =>
          b.citations.map((c) => c.url).filter((u): u is string => !!u),
        ),
      ),
    ].slice(0, 3);
    const text = `Watch update: ${watch.query.slice(0, 120)}\n${content.slice(0, 1200)}${content.length > 1200 ? "…" : ""}\n${urls.join("\n")}`;
    const key = `bell-watch-${hash(`${watch.id}:${event.event_id}`)}`;
    await this.store.transaction(async (client) => {
      const inserted = await client.query(
        "INSERT INTO bell_monitor_events (watch_id,event_id,payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id",
        [watch.id, event.event_id, event],
      );
      if (inserted.rowCount)
        await this.store.enqueue(
          "send",
          key,
          watch.id,
          { text, key, eventId: event.event_id },
          client,
        );
    });
  }
}
export function monitors() {
  return new MonitorService(monitorStore());
}
