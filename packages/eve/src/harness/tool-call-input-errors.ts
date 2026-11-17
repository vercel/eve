import type { ToolSet, TypedToolCall, TypedToolError } from "ai";

import {
  createPresentedRuntimeActionRequestFromToolCall,
  type RuntimeActionRequestProjection,
} from "#harness/action-presentation.js";
import { resolveToolCallInputObject } from "#harness/coordination.js";
import type { HarnessToolLookup } from "#harness/types.js";

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

export function resolveProviderToolCallRequest(
  toolCall: {
    readonly input?: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  },
  tools: HarnessToolLookup,
):
  | { readonly request: RuntimeActionRequestProjection; readonly toolError?: undefined }
  | { readonly request?: undefined; readonly toolError: TypedToolError<ToolSet> } {
  try {
    return {
      request: createPresentedRuntimeActionRequestFromToolCall({
        toolCall: {
          ...toolCall,
          providerExecuted: true,
          type: "tool-call",
        } as TypedToolCall<ToolSet>,
        tools,
      }),
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
