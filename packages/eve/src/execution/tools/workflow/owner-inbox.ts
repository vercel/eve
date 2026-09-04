import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type {
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunReport,
  WorkflowToolRunRef,
  WorkflowToolInputRequestBatch,
  WorkflowToolRequest,
  WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type { ToolInputRequest } from "#tools/definition.js";
import type { WorkflowToolRunTaskInputRequest } from "#execution/tasks/child/workflow.js";
import type { TaskCommand, TaskInboundMessage, TaskInboundUpdate } from "#tasks/types.js";
import { isTaskMessage } from "#tools/task.js";
import { SUBAGENT_EXECUTION_FAILED } from "#subagents/agent-handle-errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";

export function workflowToolRunOutcomeToToolResult(
  message: WorkflowToolRunOutcomeMessage,
): RuntimeToolResultActionResult {
  const { from, result } = message;
  if (result.status === "completed") {
    return {
      callId: from.callId,
      kind: "tool-result",
      output: result.output,
      toolName: from.toolName,
    };
  }
  return {
    callId: from.callId,
    isError: true,
    kind: "tool-result",
    output:
      result.status === "failed"
        ? errorMessage(result.error)
        : (result.reason ?? "The workflow tool run was cancelled."),
    toolName: from.toolName,
  };
}

/** Reads a blocking agent result returned through an ordinary run outcome. */
export function workflowToolRunOutcomeToSubagentResult(
  message: WorkflowToolRunOutcomeMessage,
): RuntimeSubagentResult {
  if (message.result.status === "completed" && isRuntimeSubagentResult(message.result.output)) {
    return message.result.output;
  }
  const output =
    message.result.status === "failed"
      ? errorMessage(message.result.error)
      : message.result.status === "cancelled"
        ? (message.result.reason ?? "The agent invocation was cancelled.")
        : "The agent invocation returned an invalid result.";
  return {
    callId: message.from.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output,
    subagentName: message.from.toolName,
  };
}

export function workflowToolRunOutcomeToTaskCommand(
  message: WorkflowToolRunOutcomeMessage,
): TaskCommand {
  if (message.result.status === "completed") {
    return { data: message.result.output, kind: "complete" };
  }
  if (message.result.status === "failed") {
    return {
      data:
        message.from.resultKind === "subagent"
          ? subagentFailureOutput(message.result.error)
          : errorMessage(message.result.error),
      kind: "fail",
    };
  }
  return { kind: "cancel" };
}

function subagentFailureOutput(error: unknown): JsonValue {
  const parsed = parseJsonValueOrUndefined(error);
  if (
    parsed !== undefined &&
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof Reflect.get(parsed, "code") === "string"
  ) {
    return parsed;
  }
  return {
    code: SUBAGENT_EXECUTION_FAILED,
    message: errorMessage(error),
  };
}

export function workflowToolRunReportToTaskPayload(
  report: WorkflowToolRunReport,
  taskId: string,
  updateIndex: number,
): TaskInboundMessage | TaskInboundUpdate {
  if (isTaskMessage(report.update)) {
    return {
      callId: report.from.callId,
      kind: "task-message",
      message: report.update.message,
      messageEpoch: taskId,
      messageIndex: updateIndex,
    };
  }
  return {
    callId: report.from.callId,
    kind: "task-update",
    message: typeof report.update === "string" ? report.update : JSON.stringify(report.update),
    updateEpoch: taskId,
    updateIndex,
  };
}

function isRuntimeSubagentResult(value: unknown): value is RuntimeSubagentResult {
  if (typeof value !== "object" || value === null) return false;
  const origin = Reflect.get(value, "origin");
  return (
    Reflect.get(value, "kind") === "subagent-result" &&
    (origin === "child" || origin === "dispatch")
  );
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function parseJsonValueOrUndefined(value: unknown): JsonValue | undefined {
  try {
    return parseJsonValue(value);
  } catch {
    return undefined;
  }
}

export function workflowToolRunRequestToInputRequestPayload(
  message: WorkflowToolRunRequestMessage,
): SubagentInputRequestHookPayload {
  const { from, replyTo, request, requestCoordinates } = message;
  return {
    callId: from.callId,
    childContinuationToken: replyTo,
    childSessionId: from.runId,
    event: {
      requests:
        request.kind === "input-batch"
          ? request.requests
          : [normalizeInputRequest(request, from, replyTo)],
      sequence: requestCoordinates?.sequence ?? from.sequence,
      stepIndex: requestCoordinates?.stepIndex ?? from.stepIndex,
      turnId: requestCoordinates?.turnId ?? from.turnId,
    },
    kind: "subagent-input-request",
    subagentName: from.toolName,
  };
}

export function workflowToolRunRequestToTaskInputRequest(
  message: WorkflowToolRunRequestMessage,
): WorkflowToolRunTaskInputRequest {
  const { from, replyTo, request, requestCoordinates } = message;
  const base = {
    kind: "task-input-request" as const,
    replyTo,
    sequence: requestCoordinates?.sequence ?? from.sequence,
    stepIndex: requestCoordinates?.stepIndex ?? from.stepIndex,
    turnId: requestCoordinates?.turnId ?? from.turnId,
  };
  return request.kind === "input-batch"
    ? { ...base, requests: request.requests }
    : { ...base, request: normalizeInputRequest(request, from, replyTo) };
}

function normalizeInputRequest(
  request: Exclude<WorkflowToolRequest, WorkflowToolInputRequestBatch>,
  from: WorkflowToolRunRef,
  requestId: string,
): InputRequest {
  switch (request.kind) {
    case "agent-invoke":
    case "agent-settled":
      throw new TypeError("A workflow agent request cannot be normalized as human input.");
    case "authorization-request":
      throw new TypeError("A workflow authorization event cannot be normalized as human input.");
    case "ask":
      return normalizeAskRequest(request.request, from, requestId);
    default:
      return request;
  }
}

function normalizeAskRequest(
  authored: ToolInputRequest,
  from: WorkflowToolRunRef,
  requestId: string,
): InputRequest {
  if (typeof authored.prompt !== "string" || authored.prompt.length === 0) {
    throw new TypeError("A workflow tool run request needs a non-empty `prompt`.");
  }
  const normalized: InputRequest = {
    action: { callId: from.callId, input: from.input, kind: "tool-call", toolName: from.toolName },
    kind: "question",
    prompt: authored.prompt,
    requestId,
  };
  if (authored.allowFreeform !== undefined) normalized.allowFreeform = authored.allowFreeform;
  if (authored.display !== undefined) normalized.display = authored.display;
  if (authored.options !== undefined) normalized.options = [...authored.options];
  return normalized;
}
