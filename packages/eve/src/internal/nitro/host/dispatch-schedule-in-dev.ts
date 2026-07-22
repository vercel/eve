import type { DevelopmentNitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";
import { loadResolvedCompiledSchedules } from "#runtime/schedules/resolve-schedule.js";

/**
 * Result of dispatching one authored schedule via the dev-only HTTP route.
 */
export interface DispatchScheduleInDevResult {
  readonly scheduleId: string;
  readonly sessionIds: readonly string[];
}

/**
 * Error raised when the dev-only schedule dispatch route is given a
 * schedule id that does not match any compiled authored schedule.
 *
 * The route handler maps this to an HTTP 404 with the list of available
 * schedule ids so callers can correct their request without grepping the
 * server's logs.
 */
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

/**
 * Dispatches one compiled authored schedule in-process inside the running
 * dev server. Used by the dev-only `POST /eve/v1/dev/schedules/:scheduleId`
 * HTTP route to fire a schedule out-of-band without registering it with
 * Nitro's cron scheduler.
 *
 * The dispatch path is the same one the production cron handler uses:
 * `dispatchScheduleTask` resolves the compiled schedule, loads the agent
 * bundle, and invokes `ScheduleDispatcher.trigger(...)`. The dev server's
 * workflow runtime owns the resulting sessions, so the caller can stream
 * them via the existing `/eve/v1/session/:sessionId/stream` route as soon
 * as this resolves.
 *
 * Re-resolves authored schedule registrations from disk on every call so
 * the route picks up edits made by the authored-source watcher without a
 * dev-server restart.
 *
 * The artifacts config is resolved before Nitro bundles this module and
 * baked into the virtual handler. Re-deriving its loader path here would
 * resolve relative to the app instead of the installed eve package.
 */
export async function dispatchScheduleInDev(input: {
  readonly artifactsConfig: DevelopmentNitroArtifactsConfig;
  readonly scheduleId: string;
}): Promise<DispatchScheduleInDevResult> {
  const { appRoot, moduleMapLoaderPath } = input.artifactsConfig;
  if (!appRoot || !moduleMapLoaderPath) {
    throw new Error(
      'Dev schedule dispatch requires "appRoot" and "moduleMapLoaderPath" in the artifacts config.',
    );
  }

  // Resolve the active generation once and reuse it for the task dispatch so
  // a rebuild between the two loads cannot split them across generations.
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
  );

  return {
    scheduleId: result.scheduleId,
    sessionIds: [...result.sessionIds],
  };
}
