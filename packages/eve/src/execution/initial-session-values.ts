import type { CreateSessionStepResult } from "#execution/create-session-step.js";
import { DURABLE_SESSION_VERSION } from "#execution/durable-session-read.js";
import { createSession, projectToDurableSession } from "#execution/session.js";
import { withPendingHistory } from "#execution/session/pending-history.js";
import type { JsonObject } from "#shared/json.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

/**
 * A new root session's initial durable state and history, as `createSessionStep` makes them.
 * It imports nothing the workflow bundle can't hold, so a workflow body computes it without a
 * step. A new session relays no input requests, so it needs no HITL state read.
 */
export function createInitialSessionValues(input: {
  readonly continuationToken: string;
  /** History from `create()`, held until the first message's turn adds it. */
  readonly history?: readonly SessionHistoryMessage[];
  readonly outputSchema?: JsonObject;
  readonly rootSessionId?: string;
  readonly sessionId: string;
}): CreateSessionStepResult {
  const created = createSession({
    continuationToken: input.continuationToken,
    outputSchema: input.outputSchema,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
  });
  const state = withPendingHistory(created.state, input.history);
  const session = projectToDurableSession(
    state === created.state ? created : { ...created, state },
  );
  return {
    history: created.history,
    state: {
      continuationToken: session.continuationToken,
      hasProxyInputRequests: false,
      sessionId: session.sessionId,
      version: DURABLE_SESSION_VERSION,
      snapshot: { session },
    },
  };
}
