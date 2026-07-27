import type { ToolSet, TypedToolCall, TypedToolError } from "ai";

import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
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

/**
 * Resolves a provider-executed tool call into an observable runtime-action
 * request, or the synthesized tool error when the model emitted arguments
 * that cannot satisfy the JSON-object contract.
 *
 * Provider-executed calls skip the AI SDK's input validation, so malformed
 * JSON argument text reaches the harness only here.
 */
export function resolveProviderToolCallRequest(toolCall: {
  readonly input?: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}):
  | { readonly request: RuntimeToolCallActionRequest; readonly toolError?: undefined }
  | { readonly request?: undefined; readonly toolError: TypedToolError<ToolSet> } {
  try {
    return {
      request: {
        callId: toolCall.toolCallId,
        input: resolveToolCallInputObject(toolCall.input, {
          callId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        }),
        kind: "tool-call",
        toolName: toolCall.toolName,
      },
    };
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return {
      toolError: createInvalidToolCallInputError({
        error,
        toolCall: {
          input: toolCall.input,
          providerExecuted: true,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          type: "tool-call",
        } as TypedToolCall<ToolSet>,
      }),
    };
  }
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
