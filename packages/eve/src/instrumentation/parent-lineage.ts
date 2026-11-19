import type { SessionCallback, SessionParent } from "#channel/types.js";
import { isSubagentAdapterState } from "#subagents/adapter-state.js";
import type { InstrumentationParentLineage } from "#instrumentation/lifecycle.js";

export function resolveParentLineage(
  parent: SessionParent | undefined,
  adapter: { readonly state?: unknown } | undefined,
  callback?: SessionCallback,
): InstrumentationParentLineage | undefined {
  if (parent === undefined) return undefined;
  const state = adapter?.state;
  const subagent = isSubagentAdapterState(state) ? state : undefined;
  return {
    callId: callback?.callId ?? subagent?.callId ?? parent.callId,
    sessionId: parent.sessionId,
    subagentName: callback?.subagentName ?? subagent?.subagentName,
    turnId: parent.turn.id,
  };
}
