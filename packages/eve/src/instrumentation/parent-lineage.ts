import type { SessionCallback, SessionParent } from "#channel/types.js";
import { isSubagentAdapterState } from "#subagents/adapter-state.js";
import type { InstrumentationParentLineage } from "#instrumentation/lifecycle.js";

/**
 * Resolves the dispatch that created the running session, if any. Dispatch
 * splits the lineage across two owners — the identifiers onto
 * {@link SessionParent}, the subagent name onto the adapter state — so both
 * are read here rather than either being duplicated onto the other.
 */
export function resolveParentLineage(
  parent: SessionParent | undefined,
  adapter: { readonly state?: unknown } | undefined,
  callback?: SessionCallback,
): InstrumentationParentLineage | undefined {
  if (parent === undefined) {
    return callback?.parentRunId && callback.parentTurnId
      ? {
          callId: callback.callId,
          sessionId: callback.parentRunId,
          subagentName: callback.subagentName,
          turnId: callback.parentTurnId,
        }
      : undefined;
  }
  const state = adapter?.state;
  const subagent = isSubagentAdapterState(state) ? state : undefined;
  return {
    callId: callback?.callId ?? subagent?.callId ?? parent.callId,
    sessionId: parent.sessionId,
    subagentName: subagent?.subagentName,
    turnId: parent.turn.id,
  };
}
