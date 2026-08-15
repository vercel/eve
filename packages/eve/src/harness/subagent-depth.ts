import { SubagentDepthKey } from "#context/keys.js";
import type { HarnessSession } from "#harness/types.js";
import type {
  RuntimeActionRequest,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";

export type DelegatedRuntimeActionRequest =
  | RuntimeRemoteAgentCallActionRequest
  | RuntimeSubagentCallActionRequest;

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
  action: RuntimeActionRequest,
): action is DelegatedRuntimeActionRequest {
  return action.kind === "subagent-call" || action.kind === "remote-agent-call";
}

export function getSubagentDelegationName(action: DelegatedRuntimeActionRequest): string {
  switch (action.kind) {
    case "remote-agent-call":
      return action.remoteAgentName;
    case "subagent-call":
      return action.subagentName;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function parseSubagentDepth(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}
