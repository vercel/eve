import type {
  RuntimeAgentDispatchRequest,
  RuntimeSubagentChildResult,
  RuntimeSubagentResult,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";
import { isObject } from "#shared/guards.js";
import type { JsonValue } from "#shared/json.js";
import { SUBAGENT_EXECUTION_FAILED } from "#subagents/agent-handle-errors.js";
import type { TaskError, TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { AGENT_CALL_CANCELLED_MESSAGE } from "#tasks/render.js";

// Conversions between the child's settled turn, the kernel's outcome, and
// the tool result the owner's model reads.

export function toTaskOutcome(result: RuntimeSubagentChildResult): TaskOutcome {
  const turn = result.outcome.result;
  switch (turn.kind) {
    case "succeeded":
      return { output: turn.output, status: "completed" };
    case "failed":
      return { error: toTaskError(turn.error), status: "failed" };
    case "cancelled":
      return { status: "cancelled" };
  }
}

export function toTaskError(value: JsonValue): TaskError {
  if (isObject(value)) {
    const code = typeof value.code === "string" ? value.code : "EXECUTION_FAILED";
    const message = typeof value.message === "string" ? value.message : JSON.stringify(value);
    return { code, message };
  }
  return {
    code: "EXECUTION_FAILED",
    message: typeof value === "string" ? value : JSON.stringify(value),
  };
}

export function toToolResult(
  record: TaskRecord,
  result: RuntimeSubagentChildResult,
  outcome: TaskOutcome,
): RuntimeToolResultActionResult {
  if (outcome.status === "completed") {
    return {
      callId: record.callId,
      kind: "tool-result",
      output: result.output,
      toolName: record.name,
    };
  }
  return {
    callId: record.callId,
    isError: true,
    kind: "tool-result",
    output:
      outcome.status === "failed"
        ? result.output
        : { code: SUBAGENT_EXECUTION_FAILED, message: AGENT_CALL_CANCELLED_MESSAGE },
    toolName: record.name,
  };
}

export function createFailedResult(
  action: RuntimeAgentDispatchRequest,
  callId: string,
  output: JsonValue,
): RuntimeSubagentResult {
  return {
    callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output,
    subagentName:
      action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName,
  };
}
