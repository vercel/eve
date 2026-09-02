import { SubagentDepthKey } from "#context/keys.js";
import type { HarnessSession } from "#harness/types.js";
import type { PendingAgentDispatchAction, PendingDispatchAction } from "#shared/dispatch-action.js";

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
  action: PendingDispatchAction,
): action is PendingAgentDispatchAction {
  return (
    action.target.kind === "self-agent-call" ||
    action.target.kind === "subagent-call" ||
    action.target.kind === "remote-agent-call"
  );
}

export function getSubagentDelegationName(action: PendingAgentDispatchAction): string {
  switch (action.target.kind) {
    case "remote-agent-call":
      return action.target.remoteAgentName;
    case "self-agent-call":
    case "subagent-call":
      return action.target.subagentName;
    default: {
      const _exhaustive: never = action.target;
      return _exhaustive;
    }
  }
}

function parseSubagentDepth(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}
