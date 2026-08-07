import { REMOTE_AGENT_START_FAILED } from "#harness/agent-handle-errors.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentDispatchFailure,
} from "#runtime/actions/types.js";
import { toErrorMessage } from "#shared/errors.js";

export function createUnavailableDynamicSubagentResult(
  action: RuntimeSubagentCallActionRequest | RuntimeRemoteAgentCallActionRequest,
): RuntimeSubagentDispatchFailure {
  const subagentName = getSubagentName(action);
  return {
    callId: action.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: "SUBAGENT_UNAVAILABLE",
      message: `Subagent "${subagentName}" is not available in the current session context.`,
    },
    subagentName,
  };
}

export function getSubagentName(
  action: RuntimeSubagentCallActionRequest | RuntimeRemoteAgentCallActionRequest,
): string {
  return action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
}

export function createRemoteAgentStartFailureResult(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly error: unknown;
}): RuntimeSubagentDispatchFailure {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: REMOTE_AGENT_START_FAILED,
      message: toErrorMessage(input.error),
    },
    subagentName: input.action.remoteAgentName,
  };
}

export function createRecursiveAgentRootOnlyResult(
  action: RuntimeSubagentCallActionRequest,
): RuntimeSubagentDispatchFailure {
  return {
    callId: action.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: "RECURSIVE_AGENT_ROOT_ONLY",
      message: 'The built-in "agent" tool is only available to the root session.',
    },
    subagentName: action.subagentName,
  };
}
