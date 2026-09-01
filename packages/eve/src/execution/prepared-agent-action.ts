import type { RuntimeAgentHandleAction } from "#execution/agent-handle-dispatch.js";
import type { PendingAgentDispatchAction } from "#shared/dispatch-action.js";

/** Converts a prepared dispatch identity into the existing agent transport contract. */
export function resolvePreparedAgentAction(action: PendingAgentDispatchAction): {
  readonly action: RuntimeAgentHandleAction;
  readonly selfAgent: boolean;
} {
  const common = {
    callId: action.callId,
    description: action.description,
    input: action.input,
    name: action.toolName,
    nodeId: action.target.nodeId,
  };
  switch (action.target.kind) {
    case "remote-agent-call":
      return {
        action: {
          ...common,
          kind: "remote-agent-call",
          remoteAgentName: action.target.remoteAgentName,
        },
        selfAgent: false,
      };
    case "self-agent-call":
      return {
        action: {
          ...common,
          kind: "subagent-call",
          subagentName: action.target.subagentName,
        },
        selfAgent: true,
      };
    case "subagent-call":
      return {
        action: {
          ...common,
          kind: "subagent-call",
          subagentName: action.target.subagentName,
        },
        selfAgent: false,
      };
  }
}
