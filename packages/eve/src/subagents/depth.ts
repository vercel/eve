import { SubagentDepthKey } from "#context/keys.js";
import type { HarnessSession } from "#harness/types.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeRemoteAgentDispatchRequest,
  RuntimeSubagentDispatchRequest,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";

export type DelegatedTaskRequest =
  | RuntimeRemoteAgentDispatchRequest
  | RuntimeSubagentDispatchRequest
  | (RuntimeWorkflowTaskRequest & { readonly resultKind: "subagent" });

export type ResolvedSubagentDepth = {
  readonly currentDepth: number;
  readonly nextChildDepth: number;
};

export function resolveSubagentDepth(
  session: Pick<HarnessSession, "subagentDepth">,
): ResolvedSubagentDepth {
  const currentDepth = parseSubagentDepth(session.subagentDepth);
  return {
    currentDepth,
    nextChildDepth: currentDepth + 1,
  };
}

export function readSerializedSubagentDepth(
  serializedContext: Readonly<Record<string, unknown>>,
): number | undefined {
  const subagentDepth = parseSubagentDepth(serializedContext[SubagentDepthKey.name]);
  return subagentDepth === 0 ? undefined : subagentDepth;
}

export function isSubagentDelegationAction(
  action: RuntimeAgentDispatchRequest | RuntimeWorkflowTaskRequest,
): action is DelegatedTaskRequest {
  return (
    action.kind === "subagent-call" ||
    action.kind === "remote-agent-call" ||
    (action.kind === "workflow-task" && action.resultKind === "subagent")
  );
}

export function getSubagentDelegationName(action: DelegatedTaskRequest): string {
  switch (action.kind) {
    case "remote-agent-call":
      return action.remoteAgentName;
    case "subagent-call":
      return action.subagentName;
    case "workflow-task":
      return action.toolName;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function parseSubagentDepth(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}
