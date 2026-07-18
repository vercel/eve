import type { ToolSet, TypedToolCall, TypedToolError } from "ai";

import { resolveToolCallInputObject } from "#harness/runtime-actions.js";

/**
 * Returns true when the AI SDK marked the tool call `invalid` (typically
 * because the model emitted unparsable JSON or targeted an unknown tool).
 *
 * Invalid calls have a raw-string or partial `input` payload that cannot
 * satisfy the runtime-action contract. The AI SDK synthesizes a tool-error
 * result for the next model step automatically; callers must skip invalid
 * calls when projecting to `RuntimeActionRequest` values or the harness
 * will throw on the JSON-object invariant.
 */
export function isInvalidToolCall(toolCall: TypedToolCall<ToolSet>): boolean {
  return toolCall.invalid === true;
}

export function createInvalidToolCallInputError(input: {
  readonly error: unknown;
  readonly toolCall: TypedToolCall<ToolSet>;
}): TypedToolError<ToolSet> {
  const { toolCall } = input;

  const toolError: {
    dynamic?: true;
    error: unknown;
    input: unknown;
    providerExecuted?: true;
    providerMetadata?: TypedToolCall<ToolSet>["providerMetadata"];
    toolCallId: string;
    toolMetadata?: TypedToolCall<ToolSet>["toolMetadata"];
    toolName: string;
    type: "tool-error";
  } = {
    type: "tool-error",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input,
    error: input.error,
  };

  if (toolCall.dynamic === true) {
    toolError.dynamic = true;
  }
  if (toolCall.providerExecuted === true) {
    toolError.providerExecuted = true;
  }
  if (toolCall.providerMetadata !== undefined) {
    toolError.providerMetadata = toolCall.providerMetadata;
  }
  if (toolCall.toolMetadata !== undefined) {
    toolError.toolMetadata = toolCall.toolMetadata;
  }

  return toolError as TypedToolError<ToolSet>;
}

export function getInvalidToolCallInputError(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
}): TypedToolError<ToolSet> | undefined {
  const { toolCall } = input;

  if (isInvalidToolCall(toolCall)) {
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
