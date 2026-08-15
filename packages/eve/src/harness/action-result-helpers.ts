import type { ModelMessage, ToolSet, TypedToolError, TypedToolResult } from "ai";

import type { RuntimeToolResultActionResult } from "#runtime/actions/types.js";
import { toError } from "#shared/errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import {
  authorizationPendingAsJsonObject,
  isAuthorizationSignal,
  isAuthorizationPendingModelOutput,
} from "#harness/authorization.js";
import { withToolOutputSerializationError } from "#harness/tool-output-serialization.js";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;
type ToolResultOutputCandidate =
  | ToolResultPart["output"]
  | { readonly type: "error-json" | "json"; readonly value: unknown };

/**
 * Coerces framework-owned sentinel values and validates the result payload as
 * JSON without attaching tool-specific context.
 */
function toJsonValue(value: unknown): JsonValue {
  if (isAuthorizationSignal(value)) {
    return parseJsonValue(
      authorizationPendingAsJsonObject({
        connections: value.challenges.map((entry) => entry.name),
      }),
    );
  }
  if (isAuthorizationPendingModelOutput(value)) {
    return parseJsonValue(authorizationPendingAsJsonObject(value));
  }

  return parseJsonValue(value === undefined ? null : value);
}

/**
 * Builds a `RuntimeToolResultActionResult` from a raw tool output value.
 *
 * This is the single coercion point for `action.result` projection. Both
 * native tool execution (via {@link createRuntimeToolResultFromStepResult} /
 * {@link createRuntimeToolResultFromMessagePart}) and Workflow child calls
 * funnel through here, so the raw-output-vs-`toModelOutput` decision —
 * always raw — is decided once. The output is validated as JSON here so bad
 * values never reach protocol events or persisted history.
 */
export function createRuntimeToolResultFromValue(input: {
  readonly callId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly isError?: boolean;
}): RuntimeToolResultActionResult {
  const result: RuntimeToolResultActionResult = {
    callId: input.callId,
    kind: "tool-result",
    output: toolResultOutputToJsonValue({
      output: {
        type: input.isError === true ? "error-json" : "json",
        value:
          input.isError === true && input.output instanceof Error
            ? input.output.message
            : input.output,
      },
      toolCallId: input.callId,
      toolName: input.toolName,
    }),
    toolName: input.toolName,
  };

  return input.isError === true ? { ...result, isError: true } : result;
}

/**
 * Builds a `RuntimeToolResultActionResult` from one AI SDK
 * {@link TypedToolResult}. Used for tool results captured on the AI SDK
 * step result and for `tool-result` parts that arrive on the stream.
 */
export function createRuntimeToolResultFromStepResult(
  toolResult: TypedToolResult<ToolSet>,
): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: toolResult.toolCallId,
    output: toolResult.output,
    toolName: toolResult.toolName,
  });
}

/**
 * Builds a failed `RuntimeToolResultActionResult` from one AI SDK
 * `tool-error` part.
 */
export function createRuntimeToolResultFromToolError(
  toolError: TypedToolError<ToolSet>,
): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: toolError.toolCallId,
    isError: true,
    output: toError(toolError.error),
    toolName: toolError.toolName,
  });
}

/**
 * Builds the inline tool-result message part that repairs model history after a
 * local tool execution error.
 */
export function createToolResultMessagePartFromToolError(
  toolError: TypedToolError<ToolSet>,
): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: toolError.toolCallId,
    toolName: toolError.toolName,
    output: { type: "error-text", value: toError(toolError.error).message },
  };
}

/**
 * Builds a `RuntimeToolResultActionResult` from one tool-result message
 * part as it appears on `step.response.messages`. Used as a fallback when
 * the result is missing from `step.toolResults` (some providers — notably
 * after `tool-output-denied` chunks — surface the result only on the
 * response messages array).
 */
export function createRuntimeToolResultFromMessagePart(
  part: ToolResultPart,
): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: part.toolCallId,
    output: toolResultOutputToJsonValue({
      output: part.output,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
    }),
    toolName: part.toolName,
    isError: isToolResultError(part.output),
  });
}

function toolResultOutputToJsonValue(input: {
  readonly output: ToolResultOutputCandidate;
  readonly toolCallId: string;
  readonly toolName: string;
}): JsonValue {
  return withToolOutputSerializationError(
    {
      boundary: "action.result",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
    },
    () => {
      switch (input.output.type) {
        case "text":
        case "error-text":
          return input.output.value;
        case "json":
        case "error-json":
          return toJsonValue(input.output.value);
        case "execution-denied":
          return {
            code: "TOOL_EXECUTION_DENIED",
            message: input.output.reason ?? "Tool execution was denied.",
          };
        case "content":
          return toJsonValue(input.output.value);
      }
    },
  );
}

function isToolResultError(output: ToolResultPart["output"]): boolean {
  return (
    output.type === "error-json" ||
    output.type === "error-text" ||
    output.type === "execution-denied"
  );
}
