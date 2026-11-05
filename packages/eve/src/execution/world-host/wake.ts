import type { QueueWorld } from "#execution/world/runtime-world.js";
import { sessionIdOfRun, sessionRunId } from "#execution/world/session-runs.js";

// What wakes a session on a World host: a message on the World's queue naming the session's
// run. The World delivers one message of a spec 9 run at a time (Workflow's single-orchestrator
// rule), so one process drives a session at once; the run's in-band fence refuses one that
// outlived its delivery. A wake carries nothing but the run: what it's for (a message, an answer,
// a timer that came due) is on the run's log or in its saved state already, so a wake the queue
// folds into another delivery (Vercel Queues may) loses nothing.

/** The queue namespace of a World host's wakes, which its session runs record for recovery. */
export const WORLD_HOST_QUEUE_NAMESPACE = "evesession";

/** The queue prefix a World host consumes. */
export const WORLD_HOST_QUEUE_PREFIX = `__${WORLD_HOST_QUEUE_NAMESPACE}_wkf_workflow_`;

const WAKE_QUEUE = `${WORLD_HOST_QUEUE_PREFIX}session`;

/** The spec version a fenced session run has, which the World serializes deliveries for. */
const RUN_SPEC_VERSION = 9;

/** How long the World's queues delay a message at most: Vercel Queues' 23 hours. */
export const MAX_WAKE_DELAY_SECONDS = 23 * 60 * 60;

/** The `executionContext` a World host's session runs are created with. */
export const WORLD_HOST_EXECUTION_CONTEXT = { queueNamespace: WORLD_HOST_QUEUE_NAMESPACE };

/** A wake's message. */
export interface SessionWake {
  readonly runId: string;
  readonly runSpecVersion: typeof RUN_SPEC_VERSION;
}

/**
 * Wakes `sessionId`, now or in `delaySeconds` (at most a day; a longer wait wakes the session
 * early, and it sleeps again). A timer's wake is keyed by its deadline, so the deliveries that
 * arm the same timer send it once; any other wake has no key, as a key could be absorbed by a
 * delivery that's already exiting and lose the wake.
 */
export async function wakeSession(
  world: QueueWorld,
  sessionId: string,
  options: { readonly at?: number } = {},
): Promise<void> {
  const message: SessionWake = { runId: sessionRunId(sessionId), runSpecVersion: RUN_SPEC_VERSION };
  if (options.at === undefined) {
    await world.queue(WAKE_QUEUE, message);
    return;
  }
  const delaySeconds = Math.min(
    MAX_WAKE_DELAY_SECONDS,
    Math.max(0, Math.ceil((options.at - Date.now()) / 1000)),
  );
  await world.queue(WAKE_QUEUE, message, {
    delaySeconds,
    idempotencyKey: `eve-timer:${message.runId}:${String(options.at)}`,
  });
}

/** The session a queue message wakes, if it's a wake of one. */
export function sessionOfWake(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { runId } = message as { readonly runId?: unknown };
  return typeof runId === "string" ? sessionIdOfRun(runId) : undefined;
}
