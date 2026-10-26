import { rebuildSerializableError } from "#execution/workflow-errors.js";
import type { SubagentInteractionHookPayload } from "#channel/types.js";
import type {
  WorkflowToolAskRequest,
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import type { InteractionRequest } from "#protocol/session-events/families/interaction.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
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
    ...(result.status === "failed" && { errorName: rebuildSerializableError(result.error).name }),
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
 * A run's `ctx.ask()` question, relayed like any request: an interaction the run opens, about
 * the call it serves. The run is the asker, so its question names the run as its origin.
 */
export function workflowAskPayload(
  message: WorkflowToolRunRequestMessage & { readonly request: WorkflowToolAskRequest },
): SubagentInteractionHookPayload {
  const { from, replyTo } = message;
  const authored = message.request.request;
  if (typeof authored.prompt !== "string" || authored.prompt.length === 0) {
    throw new TypeError("A workflow tool run request needs a non-empty `prompt`.");
  }
  const request: { -readonly [K in keyof InteractionRequest]: InteractionRequest[K] } = {
    kind: "question",
    prompt: authored.prompt,
  };
  if (authored.allowFreeform !== undefined) request.allowFreeform = authored.allowFreeform;
  if (authored.display !== undefined) request.display = authored.display;
  if (authored.title !== undefined) request.title = authored.title;
  if (authored.options !== undefined) request.options = [...authored.options];
  return {
    callId: from.callId,
    childSessionId: from.runId,
    events: [
      {
        data: {
          interactionId: replyTo,
          origin: {
            call: { callId: from.callId, input: from.input, name: from.toolName },
            interactionId: replyTo,
            sessionId: from.runId,
          },
          request,
          subject: { callId: from.callId },
        },
        type: "interaction.opened",
      },
    ],
    kind: "subagent-interaction",
    route: { childContinuationToken: replyTo },
    subagentName: from.toolName,
  };
}
