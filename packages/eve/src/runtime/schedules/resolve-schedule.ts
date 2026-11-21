import { expectScheduleRun } from "#channel/schedule.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { ScheduleRunHandler } from "#public/definitions/schedule.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import type { ResolvedScheduleDefinition } from "#runtime/types.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";

interface ResolveSchedulesInput {
  manifest: CompiledAgentManifest;
}

interface LoadResolvedCompiledSchedulesInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}

class ResolveScheduleError extends Error {
  readonly taskName?: string;

  constructor(
    message: string,
    input: {
      taskName?: string;
    } = {},
  ) {
    super(message);
    this.name = "ResolveScheduleError";

    if (input.taskName !== undefined) {
      this.taskName = input.taskName;
    }
  }
}

export async function resolveSchedules(
  input: ResolveSchedulesInput,
): Promise<ResolvedScheduleDefinition[]> {
  return [...input.manifest.schedules].map((schedule) => {
    const base = {
      cron: schedule.cron,
      ...(schedule.timezone !== undefined && { timezone: schedule.timezone }),
      hasRun: schedule.hasRun,
      logicalPath: schedule.logicalPath,
      name: schedule.name,
      sourceId: schedule.sourceId,
      sourceKind: schedule.sourceKind,
    };

    if (schedule.markdown !== undefined) {
      return { ...base, markdown: schedule.markdown } as ResolvedScheduleDefinition;
    }

    return base as ResolvedScheduleDefinition;
  });
}

export async function loadResolvedCompiledSchedules(
  input: LoadResolvedCompiledSchedulesInput,
): Promise<ResolvedScheduleDefinition[]> {
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: input.compiledArtifactsSource,
  });

  return await resolveSchedules({
    manifest,
  });
}

export async function loadResolvedCompiledScheduleByTaskName(
  taskName: string,
  input: LoadResolvedCompiledSchedulesInput,
): Promise<ResolvedScheduleDefinition> {
  const schedules = await loadResolvedCompiledSchedules(input);
  const scheduleBySourceId = new Map(schedules.map((schedule) => [schedule.sourceId, schedule]));

  for (const registration of createScheduleRegistrations(schedules)) {
    if (registration.taskName === taskName) {
      const schedule = scheduleBySourceId.get(registration.sourceId);

      if (schedule !== undefined) {
        return schedule;
      }
    }
  }

  throw new ResolveScheduleError(
    `No compiled authored schedule is registered for Nitro task "${taskName}".`,
    {
      taskName,
    },
  );
}

export async function loadScheduleRun(
  schedule: ResolvedScheduleDefinition,
  moduleMap: CompiledModuleMap,
): Promise<ScheduleRunHandler> {
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
