import type { TurnCaller } from "#channel/types.js";
import { CHANNEL_CONTEXT_KEY_NAME } from "#context/key-names.js";
import {
  isDirectSubagentTaskRef,
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
  type SubagentAdapterState,
} from "#subagents/adapter-state.js";

export function resolveLocalInitialTurnCaller(
  serializedContext: Record<string, unknown>,
): TurnCaller | undefined {
  const adapter = serializedContext[CHANNEL_CONTEXT_KEY_NAME];
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    Reflect.get(adapter, "kind") !== SUBAGENT_ADAPTER_KIND ||
    !isSubagentAdapterState(Reflect.get(adapter, "state"))
  ) {
    return undefined;
  }

  const state = Reflect.get(adapter, "state") as SubagentAdapterState;
  const directTask = isDirectSubagentTaskRef(state.directTask) ? state.directTask : undefined;
  return {
    callId: state.callId,
    ...(directTask !== undefined && { directTask }),
    replyTo: { kind: "hook", token: state.parentContinuationToken },
    subagentName: state.subagentName,
  };
}
