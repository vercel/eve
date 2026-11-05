import type { Runtime } from "#channel/types.js";
import type { Entities } from "#execution/entity/entities.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { dispatchScheduledOccurrence } from "#runtime/schedules/dispatch-occurrence.js";
import { loadScheduleCollectionDefinition } from "#runtime/schedules/load-collection.js";
import type { ScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { cronFiresAt } from "./cron.js";
import type { ScheduleStore, StoredWorldSchedule } from "./schedule-store.js";
import { scheduleKey } from "./schedule-store.js";

// A World host firing the dynamic schedules its World keeps (`worldScheduleProvider`): on each
// minute's tick, every active schedule due in it runs once across every process that ticks
// (`once`), as the schedule's collection says, in the sessions of the agent that created it. A
// single schedule is completed once it ran.

const log = createLogger("execution.world-host.dynamic-schedules");

/** Whether `schedule` is due in the minute starting at `minute` (epoch milliseconds). */
function dueIn(schedule: StoredWorldSchedule, at: Date, minute: number): boolean {
  if (schedule.state !== "active") return false;
  if (schedule.expression.type === "cron") return cronFiresAt(schedule.expression.cron, at);
  // A single schedule runs at the first tick at or after its time.
  return Date.parse(schedule.expression.at) < minute + 60_000;
}

export async function fireDueSchedules(input: {
  readonly store: ScheduleStore;
  readonly entities: Entities;
  readonly at: Date;
  /** The agents compiled from files the host runs: their name and artifacts. */
  readonly agents: readonly {
    readonly name: string;
    readonly source: RuntimeCompiledArtifactsSource;
  }[];
  readonly runtime: (agent: string) => Runtime;
}): Promise<readonly string[]> {
  const minute = Math.floor(input.at.getTime() / 60_000) * 60_000;
  const due = Object.values((await input.store.read()).schedules).filter((schedule) =>
    dueIn(schedule, input.at, minute),
  );
  if (due.length === 0) return [];
  // The agent each schedule belongs to: the one whose compiled name created it.
  const byApplication = new Map<string, { name: string; source: RuntimeCompiledArtifactsSource }>();
  for (const agent of input.agents) {
    const manifest = await loadCompiledManifest({ compiledArtifactsSource: agent.source });
    byApplication.set(manifest.config.name, agent);
  }
  const fired: string[] = [];
  for (const schedule of due) {
    const agent = byApplication.get(schedule.application);
    if (agent === undefined) continue;
    if (!(await input.entities.once(`schedule:${schedule.scheduleId}`, minute))) continue;
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
          executionId: `${schedule.scheduleId}:${String(minute)}`,
          name: schedule.name,
          scheduleId: schedule.scheduleId,
          scheduledAt: new Date(minute).toISOString(),
        },
        payload: schedule.payload as ScheduleCollectionPayload<unknown>,
        runtime: input.runtime(agent.name),
      });
      fired.push(schedule.name);
    } catch (error) {
      logError(log, `schedule "${schedule.name}" failed`, error, {
        scheduleId: schedule.scheduleId,
      });
    }
    if (schedule.expression.type === "single")
      await input.store.change((table) => {
        const key = scheduleKey(schedule.collection, schedule.namespace, schedule.name);
        const current = table.schedules[key];
        if (current?.scheduleId === schedule.scheduleId)
          table.schedules[key] = { ...current, state: "completed", updatedAt: Date.now() };
      });
  }
  return fired;
}
