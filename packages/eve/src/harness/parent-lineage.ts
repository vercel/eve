import type { SessionParent } from "#channel/types.js";
import { isSubagentAdapterState } from "#execution/subagent-adapter-state.js";
import type { InstrumentationParentLineage } from "#harness/instrumentation-lifecycle.js";

/**
 * Resolves the dispatch that created the running session, if any. Dispatch
 * splits the lineage across two owners — the identifiers onto
 * {@link SessionParent}, the subagent name onto the adapter state — so both
 * are read here rather than either being duplicated onto the other.
 */
export function resolveParentLineage(
  parent: SessionParent | undefined,
  adapter: { readonly state?: unknown } | undefined,
): InstrumentationParentLineage | undefined {
  if (parent === undefined) return undefined;
  const state = adapter?.state;
  return {
    callId: parent.callId,
    sessionId: parent.sessionId,
    subagentName: isSubagentAdapterState(state) ? state.subagentName : undefined,
    turnId: parent.turn.id,
  };
}
