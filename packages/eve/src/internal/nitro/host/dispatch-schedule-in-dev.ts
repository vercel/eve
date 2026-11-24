import type { DevelopmentNitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import type { App } from "#runtime/app.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";
import { loadResolvedCompiledSchedules } from "#runtime/schedules/resolve-schedule.js";

export interface DispatchScheduleInDevResult {
  readonly scheduleId: string;
  readonly sessionIds: readonly string[];
}

export class UnknownDevScheduleError extends Error {
  readonly availableScheduleIds: readonly string[];
  readonly scheduleId: string;

  constructor(scheduleId: string, availableScheduleIds: readonly string[]) {
    const suffix =
      availableScheduleIds.length === 0
        ? "No schedules are defined in this app."
        : `Available schedules: ${availableScheduleIds.map((id) => `"${id}"`).join(", ")}.`;
    super(`Unknown schedule "${scheduleId}". ${suffix}`);
    this.name = "UnknownDevScheduleError";
    this.scheduleId = scheduleId;
    this.availableScheduleIds = availableScheduleIds;
  }
}

export async function dispatchScheduleInDev(input: {
  readonly app: App;
  readonly artifactsConfig: DevelopmentNitroArtifactsConfig;
  readonly scheduleId: string;
}): Promise<DispatchScheduleInDevResult> {
  const { appRoot, moduleMapLoaderPath } = input.artifactsConfig;
  if (!appRoot || !moduleMapLoaderPath) {
    throw new Error(
      'Dev schedule dispatch requires "appRoot" and "moduleMapLoaderPath" in the artifacts config.',
    );
  }

  const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(input.artifactsConfig);
  const schedules = await loadResolvedCompiledSchedules({ compiledArtifactsSource });
  const registrations = createScheduleRegistrations(schedules);
  const registration = registrations.find((candidate) => candidate.scheduleId === input.scheduleId);

  if (registration === undefined) {
    throw new UnknownDevScheduleError(
      input.scheduleId,
      registrations.map((candidate) => candidate.scheduleId),
    );
  }

  const { dispatchScheduleTaskFromArtifacts } =
    await import("#internal/nitro/routes/schedule-task.js");
  const result = await dispatchScheduleTaskFromArtifacts(
    registration.taskName,
    compiledArtifactsSource,
    input.app,
  );

  return {
    scheduleId: result.scheduleId,
    sessionIds: [...result.sessionIds],
  };
}
