import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import type { RuntimeToolResultActionResult } from "#runtime/actions/types.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import {
  authorizationPendingAsJsonObject,
  isAuthorizationSignal,
  isAuthorizationPendingModelOutput,
} from "#harness/authorization.js";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/**
 * Coerces an arbitrary value to a JSON-safe {@link JsonValue} without
 * premature stringification.
 *
 * - Strings, numbers, booleans, and `null` pass through as primitives.
 * - `Error` instances surface only their message (no stack leak).
 * - Plain objects and arrays pass through structurally.
 * - Non-JSON-representable values (functions, symbols, BigInts) fall
 *   back to `String(value)`.
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

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "object") {
    return value as JsonValue;
  }

  return String(value);
}

/**
 * Builds a `RuntimeToolResultActionResult` from a raw tool output value.
 *
 * This is the single coercion point for `action.result` projection. Both
 * native tool execution (via {@link createRuntimeToolResultFromStepResult} /
 * {@link createRuntimeToolResultFromMessagePart}) and code-mode nested tool
 * calls funnel through here, so the raw-output-vs-`toModelOutput` decision —
 * always raw — is decided once. The output is passed through structurally
 * because it is already JSON-serialized (the AI SDK tool result, or the
 * code-mode worker bridge).
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
    output: toJsonValue(input.output),
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
    output: toolResultOutputToJsonValue(part.output),
    toolName: part.toolName,
    isError: isToolResultError(part.output),
  });
}

function toolResultOutputToJsonValue(output: ToolResultPart["output"]): JsonValue {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return toJsonValue(output.value);
    case "execution-denied":
      return {
        code: "TOOL_EXECUTION_DENIED",
        message: output.reason ?? "Tool execution was denied.",
      };
    case "content":
      return toJsonValue(output.value);
  }
}

function isToolResultError(output: ToolResultPart["output"]): boolean {
  return (
    output.type === "error-json" ||
    output.type === "error-text" ||
    output.type === "execution-denied"
  );
}
