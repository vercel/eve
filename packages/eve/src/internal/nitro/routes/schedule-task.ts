import { ScheduleDispatcher } from "#channel/schedule.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  loadResolvedCompiledScheduleByTaskName,
  loadScheduleRun,
} from "#runtime/schedules/resolve-schedule.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createLogger } from "#internal/logging.js";
import { areSchedulesDisabled, EVE_SCHEDULES_DISABLED_ENV } from "#internal/schedules/disabled.js";

const log = createLogger("schedule.dispatch");
let loggedSchedulesDisabled = false;

export async function dispatchScheduleTask(
  taskName: string,
  config: NitroArtifactsConfig,
): Promise<
  | { scheduleId: string; sessionIds: readonly string[] }
  | { skipped: "schedules-disabled"; taskName: string }
> {
  if (areSchedulesDisabled()) {
    if (!loggedSchedulesDisabled) {
      loggedSchedulesDisabled = true;
      log.info(
        `Schedules are disabled in this process (${EVE_SCHEDULES_DISABLED_ENV}); skipping "${taskName}"`,
      );
    }
    return { skipped: "schedules-disabled", taskName };
  }

  return await dispatchScheduleTaskFromArtifacts(
    taskName,
    resolveNitroCompiledArtifactsSource(config),
  );
}

export async function dispatchScheduleTaskFromArtifacts(
  taskName: string,
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<{ scheduleId: string; sessionIds: readonly string[] }> {
  const schedule = await loadResolvedCompiledScheduleByTaskName(taskName, {
    compiledArtifactsSource,
  });

  const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
  const runtime = createWorkflowRuntime({ compiledArtifactsSource });
  const dispatcher = new ScheduleDispatcher({
    runtime,
    channels: bundle.graph.root.channels,
  });

  const dispatchInput: {
    scheduleId: string;
    run?: Awaited<ReturnType<typeof loadScheduleRun>>;
    markdown?: string;
  } = { scheduleId: schedule.name };
  if (schedule.hasRun) {
    dispatchInput.run = await loadScheduleRun(schedule, bundle.moduleMap);
  }
  if (schedule.markdown !== undefined) {
    dispatchInput.markdown = schedule.markdown;
  }

  const result = await dispatcher.trigger(dispatchInput);

  if (result.waitUntilTasks.length > 0) {
    await Promise.allSettled(result.waitUntilTasks);
  }

  return {
    scheduleId: schedule.name,
    sessionIds: result.sessions.map((session) => session.sessionId),
  };
}
