import type { DurableSession } from "#execution/durable-session-store.js";
import type { HarnessSession, HarnessSessionBase } from "#harness/types.js";

export function createSession(input: {
  readonly continuationToken: string;
  readonly outputSchema?: HarnessSession["outputSchema"];
  readonly rootSessionId?: string;
  readonly sessionId: string;
}): HarnessSession {
  return {
    compaction: {},
    continuationToken: input.continuationToken,
    history: [],
    sessionId: input.sessionId,
    ...(input.rootSessionId !== undefined && { rootSessionId: input.rootSessionId }),
    ...(input.outputSchema !== undefined && { outputSchema: input.outputSchema }),
  };
}

export function mintSubagentContinuationToken(suffix?: string): string {
  return `subagent:${suffix ?? crypto.randomUUID()}`;
}

export function projectToDurableSession(session: HarnessSessionBase): DurableSession {
  const measured = session.compaction;
  return {
    continuationToken: session.continuationToken,
    sessionId: session.sessionId,
    ...(Object.values(measured).some((value) => value !== undefined) && { compaction: measured }),
    ...(session.rootSessionId !== undefined && { rootSessionId: session.rootSessionId }),
    ...(session.outputSchema !== undefined && { outputSchema: session.outputSchema }),
    ...(session.sandboxState !== undefined && { sandboxState: session.sandboxState }),
    ...(session.state !== undefined && { state: session.state }),
  };
}

export function hydrateDurableSession(durable: DurableSession): HarnessSessionBase {
  const { compaction, ...saved } = durable;
  return { ...saved, compaction: compaction ?? {} };
}
