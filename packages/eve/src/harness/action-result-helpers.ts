import type { ModelMessage, ToolSet, TypedToolError, TypedToolResult } from "ai";

import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
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

export function createRuntimeToolResultFromValue(input: {
  readonly callId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly isError?: boolean;
}): RuntimeToolResultActionResult {
  const thrown = input.isError === true && input.output instanceof Error ? input.output : undefined;
  const result: RuntimeToolResultActionResult = {
    callId: input.callId,
    kind: "tool-result",
    output: toolResultOutputToJsonValue({
      output: {
        type: input.isError === true ? "error-json" : "json",
        value: thrown === undefined ? input.output : thrown.message,
      },
      toolCallId: input.callId,
      toolName: input.toolName,
    }),
    toolName: input.toolName,
  };

  if (input.isError !== true) return result;
  return thrown === undefined
    ? { ...result, isError: true }
    : { ...result, errorName: thrown.name, isError: true };
}

export function createRuntimeToolResultFromStepResult(
  toolResult: TypedToolResult<ToolSet>,
): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: toolResult.toolCallId,
    output: toolResult.output,
    toolName: toolResult.toolName,
  });
}

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

export function createRuntimeToolResultFromMessagePart(
  part: ToolResultPart,
  toolName: string,
): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: part.toolCallId,
    output: toolResultOutputToJsonValue({
      output: part.output,
      toolCallId: part.toolCallId,
      toolName,
    }),
    toolName,
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

export function isToolResultError(output: ToolResultPart["output"]): boolean {
  return (
    output.type === "error-json" ||
    output.type === "error-text" ||
    output.type === "execution-denied"
  );
}
