import type { CreateSessionStepResult } from "#execution/create-session-step.js";
import { DURABLE_SESSION_VERSION } from "#execution/durable-session-read.js";
import { createSession, projectToDurableSession } from "#execution/session.js";
import { withPendingHistory } from "#execution/session/pending-history.js";
import type { JsonObject } from "#shared/json.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

export function createInitialSessionValues(input: {
  readonly continuationToken: string;
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
