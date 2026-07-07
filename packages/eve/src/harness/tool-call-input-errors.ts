import type { ToolSet, TypedToolCall, TypedToolError } from "ai";

import { resolveToolCallInputObject } from "#harness/runtime-actions.js";

export function createInvalidToolCallInputError(input: {
  readonly error: unknown;
  readonly toolCall: TypedToolCall<ToolSet>;
}): TypedToolError<ToolSet> {
  const { toolCall } = input;

  return {
    type: "tool-error",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input,
    error: input.error,
    ...(toolCall.dynamic === true ? { dynamic: true as const } : {}),
    ...(toolCall.providerExecuted === true ? { providerExecuted: true as const } : {}),
    ...(toolCall.providerMetadata !== undefined
      ? { providerMetadata: toolCall.providerMetadata }
      : {}),
    ...(toolCall.toolMetadata !== undefined ? { toolMetadata: toolCall.toolMetadata } : {}),
  } as TypedToolError<ToolSet>;
}

export function getInvalidToolCallInputError(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
}): TypedToolError<ToolSet> | undefined {
  const { toolCall } = input;

  if (toolCall.invalid === true) {
    return undefined;
  }

  try {
    resolveToolCallInputObject(toolCall.input, {
      callId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });
    return undefined;
  } catch (error) {
    if (error instanceof TypeError) {
      return createInvalidToolCallInputError({ error, toolCall });
    }
    throw error;
  }
}
