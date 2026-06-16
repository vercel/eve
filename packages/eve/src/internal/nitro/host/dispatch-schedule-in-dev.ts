import { createNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
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
 */
export async function dispatchScheduleInDev(input: {
  readonly appRoot: string;
  readonly scheduleId: string;
}): Promise<DispatchScheduleInDevResult> {
  const compiledArtifactsSource = createAuthoredSourceRuntimeCompiledArtifactsSource(input.appRoot);
  const schedules = await loadResolvedCompiledSchedules({ compiledArtifactsSource });
  const registrations = createScheduleRegistrations(schedules);
  const registration = registrations.find((candidate) => candidate.scheduleId === input.scheduleId);

  if (registration === undefined) {
    throw new UnknownDevScheduleError(
      input.scheduleId,
      registrations.map((candidate) => candidate.scheduleId),
    );
  }

  const { dispatchScheduleTask } = await import("#internal/nitro/routes/schedule-task.js");
  const artifactsConfig = createNitroArtifactsConfig({
    appRoot: input.appRoot,
    dev: true,
  });
  const result = await dispatchScheduleTask(registration.taskName, artifactsConfig);

  return {
    scheduleId: result.scheduleId,
    sessionIds: [...result.sessionIds],
  };
}
