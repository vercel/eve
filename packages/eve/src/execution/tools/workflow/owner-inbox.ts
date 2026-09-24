import type {
  WorkflowToolAskRequest,
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import type { InputRequest } from "#shared/input.js";
import type { TaskInputEvent, TaskInputRequest } from "#tasks/protocol.js";

type AskRequest = InputRequest & Pick<TaskInputRequest, "dismissible">;

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

/**
 * The `input.requested` event the owner surfaces for a run's `ask()`, at the
 * run's call coordinates. The request ID is the ask's reply hook, which takes
 * the answer.
 */
export function workflowAskInputEvent(
  message: WorkflowToolRunRequestMessage & { readonly request: WorkflowToolAskRequest },
): Extract<TaskInputEvent, { readonly type: "input.requested" }> {
  const { from, replyTo: requestId, request } = message;
  const authored = request.request;
  if (typeof authored.prompt !== "string" || authored.prompt.length === 0) {
    throw new TypeError("A workflow tool run request needs a non-empty `prompt`.");
  }
  const normalized: { -readonly [K in keyof AskRequest]: AskRequest[K] } = {
    action: { callId: from.callId, input: from.input, kind: "tool-call", toolName: from.toolName },
    kind: "question",
    prompt: authored.prompt,
    requestId,
  };
  if (authored.allowFreeform !== undefined) normalized.allowFreeform = authored.allowFreeform;
  if (authored.dismissible !== undefined) normalized.dismissible = authored.dismissible;
  if (authored.display !== undefined) normalized.display = authored.display;
  if (authored.options !== undefined) normalized.options = [...authored.options];
  const { sequence, stepIndex, turnId } = from;
  return { data: { requests: [normalized], sequence, stepIndex, turnId }, type: "input.requested" };
}
