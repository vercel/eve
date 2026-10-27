import { isObject } from "#shared/guards.js";

type SessionState = Readonly<Record<string, unknown>>;

const ENDING_CALLS_STATE_KEY = "eve.toolStubs.endingCalls";

/** The calls of turn `turnId` that a tool stub answered with an `endsTurn` response. */
export function readEndingStubCalls(
  state: SessionState | undefined,
  turnId: string,
): ReadonlySet<string> {
  const stored = state?.[ENDING_CALLS_STATE_KEY];
  if (!isObject(stored) || stored.turnId !== turnId || !Array.isArray(stored.callIds)) {
    return new Set();
  }
  return new Set(stored.callIds.filter((callId): callId is string => typeof callId === "string"));
}

/** Adds `callIds` to turn `turnId`'s ending calls, replacing an earlier turn's. */
export function recordEndingStubCalls<T extends { readonly state?: SessionState }>(
  session: T,
  turnId: string,
  callIds: Iterable<string>,
): T {
  const added = [...callIds];
  if (added.length === 0) return session;
  const recorded = readEndingStubCalls(session.state, turnId);
  return {
    ...session,
    state: {
      ...session.state,
      [ENDING_CALLS_STATE_KEY]: { callIds: [...new Set([...recorded, ...added])], turnId },
    },
  };
}
