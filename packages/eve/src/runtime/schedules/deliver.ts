import { areSchedulesDisabled } from "#internal/schedules/disabled.js";
import { runInApp } from "#context/app.js";
import { sessionRuntime } from "#execution/session-runtime.js";
import { dispatchScheduleTaskFromArtifacts } from "#internal/nitro/routes/schedule-task.js";
import type { AuthoredSchedule, Entities } from "#platform/entities.js";
import type { ScheduleDelivery } from "#public/schedules/provider-types.js";
import { processArtifacts, type App } from "#runtime/app.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { dispatchScheduledOccurrence } from "#runtime/schedules/dispatch-occurrence.js";
import { loadScheduleCollectionDefinition } from "#runtime/schedules/load-collection.js";
import { parseSchedulePayload } from "#runtime/schedules/payload.js";
import {
  createScheduleRegistrations,
  type ScheduleRegistration,
} from "#runtime/schedules/register.js";
import { loadResolvedCompiledSchedules } from "#runtime/schedules/resolve-schedule.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/**
 * Runs an occurrence of a dynamic schedule, in any process of the app. A schedule provider calls
 * it with the `payload` that `create()` stored and the occurrence that came due.
 */
export async function deliverScheduleOccurrence(
  app: App,
  delivery: ScheduleDelivery,
): Promise<void> {
  await runInApp(app, async () => {
    const compiledArtifactsSource = processCompiledArtifacts();
    const [bundle, manifest] = await Promise.all([
      getCompiledRuntimeAgentBundle({ compiledArtifactsSource }),
      loadCompiledManifest({ compiledArtifactsSource }),
    ]);
    const payload = parseSchedulePayload<unknown>(delivery.payload);
    const { application, collection } = payload.eve;
    if (application !== manifest.config.name) {
      throw new Error(
        `The schedule "${delivery.occurrence.name}" belongs to the agent "${application}", and this app runs "${manifest.config.name}". Deliver the occurrence to the app that made the schedule.`,
      );
    }
    await dispatchScheduledOccurrence({
      app,
      bundle,
      runtime: sessionRuntime(app.durable, app.hosts, {
        compiledArtifactsSource: bundle.compiledArtifactsSource,
      }),
      collection,
      definition: await loadScheduleCollectionDefinition(bundle, collection, { manifest }),
      occurrence: { ...delivery.occurrence, collection },
      payload,
    });
  });
}

/**
 * Runs the authored schedule `name` from `agent/schedules/`, in any process of the app. A
 * platform's `Triggers` calls it when a schedule that it received in `register()` comes due.
 */
export async function runAuthoredSchedule(app: App, name: string): Promise<void> {
  if (areSchedulesDisabled()) return;
  await runInApp(app, async () => {
    const compiledArtifactsSource = processCompiledArtifacts();
    const registration = (await authoredRegistrations(compiledArtifactsSource)).find(
      (candidate) => candidate.scheduleId === name,
    );
    if (registration === undefined) {
      throw new Error(
        `This agent has no authored schedule "${name}". Pass a name that Triggers.register() received.`,
      );
    }
    await dispatchScheduleTaskFromArtifacts(registration.taskName, compiledArtifactsSource, app);
  });
}

export async function registerAuthoredSchedules(platform: Entities): Promise<void> {
  if (platform.build.schedules?.authored !== true) return;
  const { triggers } = platform;
  if (triggers?.register === undefined) {
    throw new Error(
      "The platform sets build.schedules.authored, and its triggers give no register(). Give triggers.register() in the platform, or remove build.schedules.authored to run authored schedules on eve's scheduler.",
    );
  }
  const schedules: AuthoredSchedule[] = (
    await authoredRegistrations(processCompiledArtifacts())
  ).map(({ cron, scheduleId, timezone }) => ({
    name: scheduleId,
    cron,
    ...(timezone !== undefined && { timezone }),
  }));
  await triggers.register(schedules);
}

async function authoredRegistrations(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<ScheduleRegistration[]> {
  return createScheduleRegistrations(
    await loadResolvedCompiledSchedules({ compiledArtifactsSource }),
  );
}

function processCompiledArtifacts(): RuntimeCompiledArtifactsSource {
  const artifacts = processArtifacts();
  if (artifacts !== undefined) return artifacts();
  if (readBundledCompiledArtifacts() !== null) return createBundledRuntimeCompiledArtifactsSource();
  throw new Error(
    "This process has no compiled artifacts of the agent. Call it in a process that runs the output of eve build or eve dev.",
  );
}
