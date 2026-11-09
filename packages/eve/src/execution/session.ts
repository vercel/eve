import type { DurableSession } from "#execution/durable-session-store.js";
import type { HarnessSession, HarnessSessionBase } from "#harness/types.js";

/** Creates a fresh {@link HarnessSession}, with an empty history. */
export function createSession(input: {
  readonly continuationToken: string;
  readonly outputSchema?: HarnessSession["outputSchema"];
  /**
   * The top session's id, for a delegated subagent child. `undefined` for top-level sessions:
   * `sessionId` is the root for those.
   */
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

/**
 * Mints a continuation token for a delegated subagent session.
 * Deterministic when `suffix` is provided so retries address the same
 * child hook.
 */
export function mintSubagentContinuationToken(suffix?: string): string {
  return `subagent:${suffix ?? crypto.randomUUID()}`;
}

/**
 * Projects a {@link HarnessSessionBase} to {@link DurableSession}.
 *
 * Keeps `compaction.lastKnown*` so compaction stays informed after rehydration.
 */
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

/** Rehydrates a {@link HarnessSessionBase} from a {@link DurableSession}. */
export function hydrateDurableSession(durable: DurableSession): HarnessSessionBase {
  const { compaction, ...saved } = durable;
  return { ...saved, compaction: compaction ?? {} };
}
