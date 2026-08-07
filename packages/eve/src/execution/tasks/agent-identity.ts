import { mintStartOperation } from "#execution/dispatch-start-operation.js";
import type { RuntimeAgentHandleAction } from "#execution/agent-handle-dispatch.js";

/** Resolves the persistent agent identity attached to one delegated task. */
export function describeTaskAgent(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId?: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): {
  readonly agentId: string;
  readonly callId: string;
  readonly mode: "local" | "remote";
  readonly name: string;
} {
  const { action } = input;
  const name = action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
  const agentId =
    input.agentId ??
    mintStartOperation({
      callId: action.callId,
      name,
      nodeId: action.nodeId,
      parentSessionId: input.parentSessionId,
      parentTurnId: input.parentTurnId,
    }).identity.id;
  return {
    agentId,
    callId: action.callId,
    mode: action.kind === "remote-agent-call" ? "remote" : "local",
    name,
  };
}
