import { StreamDelivery } from "#client/delivery.js";
import { deliveryEvents } from "#client/delivery-events.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { controlCommand, type SessionControlOptions } from "#channel/types.js";
import { readSessionEventHistory, streamSessionEvents } from "#execution/session-event-stream.js";
import { prewarmWorkflowSession } from "#execution/session-prewarm.js";
import { dispatchWorkflowSessionCommand } from "#execution/workflow-runtime.js";
import { getWorld } from "#internal/workflow/runtime.js";
import type { PrewarmSessionResult } from "#protocol/prewarm-session.js";
import type { Delivery } from "#shared/delivery.js";
import type { SessionReader } from "#shared/session.js";

export type { PrewarmSessionResult };

/** Options for retiring an active or stranded session with `sessions.end()`. */
export interface SessionEndOptions extends SessionControlOptions {
  /** Optional explanation for ending the session. */
  readonly reason?: string;
}

async function resolveCurrentPrewarmDeploymentId(): Promise<string | undefined> {
  const hosted = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  if (hosted !== undefined && hosted.length > 0) return hosted;
  const world = await getWorld();
  if (world.capabilities?.deploymentAffinity !== true) return undefined;
  return (await world.getDeploymentId?.())?.trim() || undefined;
}

/**
 * In-process session access for code running inside the eve server, such as
 * hooks, tools, schedules, and channel routes.
 *
 * Available only in code running inside the eve server, where the session
 * store is configured. It operates on any session ID without channel auth, so
 * check that the caller may read, end, or prewarm a session before passing an
 * ID from a request.
 */
export const sessions = {
  /**
   * Returns a read-only handle for reading a session's recorded event stream in
   * process, without calling the deployment's own HTTP stream route.
   */
  attach(sessionId: string): SessionReader {
    return {
      id: sessionId,
      stream: (options) => streamSessionEvents(sessionId, options),
    };
  },

  /**
   * Retires an active or stranded session by ID without creating a replacement.
   * Throws `SessionNotActiveError` when the session is not active. Runs without
   * channel auth, so check that the caller may end the session before passing
   * an ID from a request.
   */
  async end(sessionId: string, options?: SessionEndOptions): Promise<Delivery> {
    const command = controlCommand({ kind: "reset", reason: options?.reason }, options);
    const result = await dispatchWorkflowSessionCommand({ command, sessionId });
    if (result.status !== "reset") {
      throw new SessionNotActiveError();
    }
    const endedSessionId = result.previousSessionId;
    return new StreamDelivery({
      sessionId: endedSessionId,
      deliveryId: command.deliveryId,
      createStream: async function* (read) {
        yield* deliveryEvents(
          readSessionEventHistory(endedSessionId, undefined, read?.signal),
          command.deliveryId,
          read?.signal,
        );
      },
    });
  },

  /**
   * Prepares an idle session to move onto the deployment running this code,
   * without starting a model turn. Runs without channel auth, so check that the
   * caller may prewarm the session before passing an ID from a request.
   */
  async prewarm(sessionId: string): Promise<PrewarmSessionResult> {
    return await prewarmWorkflowSession(sessionId, await resolveCurrentPrewarmDeploymentId());
  },
};
