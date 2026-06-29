import { SubagentDepthKey, SubagentMaxDepthKey } from "#context/keys.js";
import type { HarnessSession } from "#harness/types.js";
import type {
  RuntimeActionRequest,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";

export const DEFAULT_SUBAGENT_MAX_DEPTH = 3;

export type DelegatedRuntimeActionRequest =
  | RuntimeRemoteAgentCallActionRequest
  | RuntimeSubagentCallActionRequest;

export type SubagentDelegationLimit = {
  readonly currentDepth: number;
  readonly maxDepth: number;
  readonly nextChildDepth: number;
  readonly reached: boolean;
};

export function resolveSubagentDelegationLimit(
  session: Pick<HarnessSession, "subagentDepth" | "subagentMaxDepth">,
): SubagentDelegationLimit {
  const currentDepth = parseSubagentDepth(session.subagentDepth);
  const maxDepth = parseSubagentMaxDepth(session.subagentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
  return {
    currentDepth,
    maxDepth,
    nextChildDepth: currentDepth + 1,
    reached: currentDepth >= maxDepth,
  };
}

export function readSerializedSubagentSessionDepth(
  serializedContext: Readonly<Record<string, unknown>>,
): {
  readonly subagentDepth?: number;
  readonly subagentMaxDepth?: number;
} {
  const subagentDepth = parseSubagentDepth(serializedContext[SubagentDepthKey.name]);
  const subagentMaxDepth = parseSubagentMaxDepth(serializedContext[SubagentMaxDepthKey.name]);
  return {
    subagentDepth: subagentDepth === 0 ? undefined : subagentDepth,
    subagentMaxDepth,
  };
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

function parseSubagentMaxDepth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
