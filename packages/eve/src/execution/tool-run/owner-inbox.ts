import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type {
  RunOutcomeMessage,
  RunRef,
  RunReport,
  RunRequestMessage,
} from "#execution/tool-run/messages.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskCommand, TaskInboundUpdate } from "#tasks/types.js";
import type { ToolInputRequest } from "#tools/definition.js";

// Type-only imports: these run in the turn and task driver bodies.

/** A cancelled run settles the call as an error so the owner never waits on it. */
export function runOutcomeToToolResult(message: RunOutcomeMessage): RuntimeToolResultActionResult {
  const { from, result } = message;
  if (result.status === "completed") {
    return {
      callId: from.callId,
      kind: "tool-result",
      output: result.output,
      toolName: from.toolName,
    };
  }
  const output: JsonValue =
    result.status === "failed"
      ? errorMessage(result.error)
      : (result.reason ?? "The tool run was cancelled.");
  return {
    callId: from.callId,
    isError: true,
    kind: "tool-result",
    output,
    toolName: from.toolName,
  };
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** The answer hook token is both the request id and the route, so one resume reaches the body. */
export function runRequestToInputRequestPayload(
  message: RunRequestMessage,
): SubagentInputRequestHookPayload {
  const { from, replyTo, request } = message;
  return {
    callId: from.callId,
    childContinuationToken: replyTo,
    childSessionId: from.runId,
    event: {
      requests: [toInputRequest(request, from, replyTo)],
      sequence: 0,
      stepIndex: from.stepIndex,
      turnId: from.turnId,
    },
    kind: "subagent-input-request",
    subagentName: from.toolName,
  };
}

function toInputRequest(request: ToolInputRequest, from: RunRef, requestId: string): InputRequest {
  if (typeof request.prompt !== "string" || request.prompt.length === 0) {
    throw new TypeError("A tool run request needs a non-empty `prompt`.");
  }
  const normalized: InputRequest = {
    action: { callId: from.callId, input: from.input, kind: "tool-call", toolName: from.toolName },
    kind: "question",
    prompt: request.prompt,
    requestId,
  };
  if (request.allowFreeform !== undefined) normalized.allowFreeform = request.allowFreeform;
  if (request.display !== undefined) normalized.display = request.display;
  if (request.options !== undefined) normalized.options = [...request.options];
  return normalized;
}

export function runReportToTaskUpdate(
  message: RunReport,
  taskId: string,
  updateIndex: number,
): TaskInboundUpdate {
  return {
    callId: message.from.callId,
    kind: "task-update",
    message: typeof message.update === "string" ? message.update : JSON.stringify(message.update),
    updateEpoch: taskId,
    updateIndex,
  };
}

/** A cancelled run only settles the executor: the task itself was already cancelled. */
export function runOutcomeToTaskCommand(message: RunOutcomeMessage): TaskCommand {
  const { result } = message;
  if (result.status === "completed") {
    return { data: result.output, kind: "complete", lifecycle: "terminal" };
  }
  if (result.status === "failed") {
    return { data: errorMessage(result.error), kind: "fail", lifecycle: "terminal" };
  }
  return { kind: "settle-executor" };
}
