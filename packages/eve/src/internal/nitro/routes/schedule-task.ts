import { expectScheduleRun, ScheduleDispatcher } from "#channel/schedule.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import { loadResolvedCompiledScheduleByTaskName } from "#runtime/schedules/resolve-schedule.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

/**
 * Dispatches one eve authored schedule via the execution engine.
 *
 * Fire-and-forget: the workflow runtime owns terminal completion and
 * its own failure observability. The task return value reports which
 * session ids the handler started so Nitro / dev tools can correlate.
 */
export async function dispatchScheduleTask(
  taskName: string,
  config: NitroArtifactsConfig,
): Promise<{ scheduleId: string; sessionIds: readonly string[] }> {
  return await dispatchScheduleTaskFromArtifacts(
    taskName,
    resolveNitroCompiledArtifactsSource(config),
  );
}

/**
 * Variant of {@link dispatchScheduleTask} for callers that already resolved
 * an artifact source and need the dispatch to stay on that generation.
 */
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
    sessionIds: result.sessions.map((session) => session.id),
  };
}

async function loadScheduleRun(
  schedule: Awaited<ReturnType<typeof loadResolvedCompiledScheduleByTaskName>>,
  moduleMap: Awaited<ReturnType<typeof getCompiledRuntimeAgentBundle>>["moduleMap"],
) {
  if (schedule.sourceKind !== "module") {
    throw new Error(
      `Schedule "${schedule.name}" claims hasRun but is not a module-backed schedule.`,
    );
  }
  const moduleSchedule = schedule as Extract<typeof schedule, { sourceKind: "module" }>;
  const exportValue = await loadResolvedModuleExport({
    definition: {
      exportName: moduleSchedule.exportName,
      logicalPath: moduleSchedule.logicalPath,
      sourceId: moduleSchedule.sourceId,
    },
    kindLabel: "schedule",
    moduleMap,
    nodeId: undefined,
  });
  return expectScheduleRun(exportValue, moduleSchedule.logicalPath, moduleSchedule.exportName);
}
