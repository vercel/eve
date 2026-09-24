import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type {
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRef,
  WorkflowToolInputRequestBatch,
  WorkflowToolRequest,
  WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type { ToolInputRequest } from "#tools/definition.js";
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
        ? workflowToolRunFailureOutput(message)
        : (result.reason ?? "The workflow tool run was cancelled."),
    toolName: from.toolName,
  };
}

export function workflowToolRunFailureOutput(message: WorkflowToolRunOutcomeMessage): JsonValue {
  if (message.result.status !== "failed")
    throw new TypeError("Expected a failed workflow outcome.");
  const parsed = parseJsonValueOrUndefined(message.result.error);
  return parsed !== undefined &&
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof Reflect.get(parsed, "code") === "string"
    ? parsed
    : errorMessage(message.result.error);
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
  const { from, replyTo, requestCoordinates } = message;
  return {
    callId: from.callId,
    childContinuationToken: replyTo,
    childSessionId: from.runId,
    event: {
      requests: workflowToolRunInputRequests(message),
      sequence: requestCoordinates?.sequence ?? from.sequence,
      stepIndex: requestCoordinates?.stepIndex ?? from.stepIndex,
      turnId: requestCoordinates?.turnId ?? from.turnId,
    },
    kind: "subagent-input-request",
    subagentName: from.toolName,
  };
}

export function workflowToolRunInputRequests(
  message: WorkflowToolRunRequestMessage,
): readonly InputRequest[] {
  return message.request.kind === "input-batch"
    ? message.request.requests
    : [normalizeInputRequest(message.request, message.from, message.replyTo)];
}

function normalizeInputRequest(
  request: Exclude<WorkflowToolRequest, WorkflowToolInputRequestBatch>,
  from: WorkflowToolRunRef,
  requestId: string,
): InputRequest {
  switch (request.kind) {
    case "agent-invoke":
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
