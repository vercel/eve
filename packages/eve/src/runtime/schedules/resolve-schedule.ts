import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import type { ResolvedScheduleDefinition } from "#runtime/types.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";

/**
 * Input for resolving authored schedules from the compiled manifest.
 */
interface ResolveSchedulesInput {
  manifest: CompiledAgentManifest;
}

/**
 * Explicit compiled-artifact source used to resolve schedules from runtime
 * artifacts.
 */
interface LoadResolvedCompiledSchedulesInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}

/**
 * Error raised when compiled authored schedules cannot be hydrated into one
 * runtime-owned schedule model.
 */
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

/**
 * Resolves runtime-owned schedules from the compiled manifest.
 */
export async function resolveSchedules(
  input: ResolveSchedulesInput,
): Promise<ResolvedScheduleDefinition[]> {
  return [...input.manifest.schedules].map((schedule) => {
    const base = {
      cron: schedule.cron,
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

/**
 * Loads the compiled manifest, then resolves authored schedules into
 * runtime-owned schedule models.
 */
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

/**
 * Loads and resolves one compiled authored schedule from its registered Nitro
 * task name.
 */
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
