import type { Runtime } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { dispatchScheduledOccurrence } from "#runtime/schedules/dispatch-occurrence.js";
import { loadScheduleCollectionDefinition } from "#runtime/schedules/load-collection.js";
import type { ScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { cronFiresAt } from "./cron.js";
import type { PendingOccurrence, ScheduleStore, StoredWorldSchedule } from "./schedule-store.js";

// A World host firing the dynamic schedules its World keeps (`worldScheduleProvider`). On each
// minute's tick, every active schedule due in that minute becomes a pending occurrence in the
// schedule table, once however many processes tick. Then a tick dispatches what's pending that no
// one holds: it takes a lease on each in the table first, so processes don't dispatch one at once.
// A dispatch that succeeds removes its occurrence (and completes a single schedule); one that fails,
// or a process that died holding the lease, leaves it pending for a later tick, up to
// `MAX_ATTEMPTS`. So each occurrence runs at least once, as the schedule's callback is told.

const log = createLogger("execution.world-host.dynamic-schedules");

/** How long a dispatch holds its occurrence before another tick may take it over. */
const LEASE_MS = 5 * 60_000;
/** Dispatches of one occurrence before it's dropped, logged. */
const MAX_ATTEMPTS = 5;

/** Whether `schedule` is due in the minute starting at `minute` (epoch milliseconds). */
function dueIn(schedule: StoredWorldSchedule, at: Date, minute: number): boolean {
  if (schedule.state !== "active") return false;
  if (schedule.expression.type === "cron") return cronFiresAt(schedule.expression.cron, at);
  // A single schedule runs at the first tick at or after its time.
  return Date.parse(schedule.expression.at) < minute + 60_000;
}

/**
 * The minute an occurrence of `schedule` due now is for: this one for a cron schedule, and its
 * time's for a single one, which then is one occurrence whichever tick finds it due.
 */
function occurrenceMinute(schedule: StoredWorldSchedule, minute: number): number {
  if (schedule.expression.type !== "single") return minute;
  return Math.floor(Date.parse(schedule.expression.at) / 60_000) * 60_000;
}

const executionIdOf = (scheduleId: string, minute: number) => `${scheduleId}:${String(minute)}`;

export async function fireDueSchedules(input: {
  readonly store: ScheduleStore;
  readonly at: Date;
  /** The agents compiled from files the host runs: their name and artifacts. */
  readonly agents: readonly {
    readonly name: string;
    readonly source: RuntimeCompiledArtifactsSource;
  }[];
  readonly runtime: (agent: string) => Runtime;
}): Promise<readonly string[]> {
  const { store } = input;
  const minute = Math.floor(input.at.getTime() / 60_000) * 60_000;
  // The agent each schedule belongs to: the one whose compiled name created it.
  const byApplication = new Map<string, { name: string; source: RuntimeCompiledArtifactsSource }>();
  for (const agent of input.agents) {
    const manifest = await loadCompiledManifest({ compiledArtifactsSource: agent.source });
    byApplication.set(manifest.config.name, agent);
  }
  const ours = (schedule: StoredWorldSchedule) => byApplication.has(schedule.application);

  const table = await store.read();
  // What's due this minute, pending once: the operation id makes every tick of it one change.
  const due = Object.entries(table.schedules).filter(
    ([, schedule]) => ours(schedule) && dueIn(schedule, input.at, minute),
  );
  if (due.length > 0)
    await store.change(
      (current) => {
        const pending = (current.pending ??= {});
        for (const [key, schedule] of due) {
          const at = occurrenceMinute(schedule, minute);
          pending[executionIdOf(schedule.scheduleId, at)] ??= {
            attempts: 0,
            key,
            leaseUntil: 0,
            minute: at,
            scheduleId: schedule.scheduleId,
          };
        }
      },
      `occurrences:${String(minute)}`,
    );
  else if (Object.keys(table.pending ?? {}).length === 0) return [];

  // What's pending that no one holds, taken: held by this tick until it's done with each.
  const now = Date.now();
  const taken = await store.change((current) => {
    const held: [string, PendingOccurrence, StoredWorldSchedule][] = [];
    for (const [executionId, occurrence] of Object.entries(current.pending ?? {})) {
      if (occurrence.leaseUntil > now) continue;
      const schedule = current.schedules[occurrence.key];
      // Removed, replaced or paused since: its occurrence goes with it.
      if (schedule?.scheduleId !== occurrence.scheduleId || schedule.state !== "active") {
        delete current.pending![executionId];
        continue;
      }
      if (!ours(schedule)) continue;
      const lease = {
        ...occurrence,
        attempts: occurrence.attempts + 1,
        leaseUntil: now + LEASE_MS,
      };
      current.pending![executionId] = lease;
      held.push([executionId, lease, schedule]);
    }
    return held;
  });

  const fired: string[] = [];
  for (const [executionId, occurrence, schedule] of taken) {
    const agent = byApplication.get(schedule.application)!;
    let ran = false;
    try {
      const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource: agent.source });
      const definition = await loadScheduleCollectionDefinition(bundle, schedule.collection, {
        providerKind: "world",
      });
      await dispatchScheduledOccurrence({
        bundle,
        collection: schedule.collection,
        definition,
        occurrence: {
          collection: schedule.collection,
          executionId,
          name: schedule.name,
          scheduleId: schedule.scheduleId,
          scheduledAt: new Date(occurrence.minute).toISOString(),
        },
        payload: schedule.payload as ScheduleCollectionPayload<unknown>,
        runtime: input.runtime(agent.name),
      });
      ran = true;
      fired.push(schedule.name);
    } catch (error) {
      logError(log, `schedule "${schedule.name}" failed`, error, {
        attempt: occurrence.attempts,
        scheduleId: schedule.scheduleId,
      });
    }
    const gaveUp = !ran && occurrence.attempts >= MAX_ATTEMPTS;
    if (gaveUp)
      log.error(`schedule "${schedule.name}" gave up on an occurrence`, {
        attempts: occurrence.attempts,
        executionId,
      });
    await store.change((current) => {
      if (ran || gaveUp) delete current.pending?.[executionId];
      // Failed: the next tick tries again.
      else if (current.pending?.[executionId] !== undefined)
        current.pending[executionId] = { ...current.pending[executionId]!, leaseUntil: 0 };
      if (!ran || schedule.expression.type !== "single") return;
      const latest = current.schedules[occurrence.key];
      if (latest?.scheduleId === schedule.scheduleId)
        current.schedules[occurrence.key] = {
          ...latest,
          state: "completed",
          updatedAt: Date.now(),
        };
    });
  }
  return fired;
}
