import { NoSuchToolError, type ToolSet, type TypedToolCall } from "ai";

import { createActionInvalidEvent, type ActionInvalidStreamEvent } from "#protocol/message.js";
import { toError } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";

interface ActionInvalidEventCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** Converts an AI SDK invalid tool call into eve's public invalid-action event. */
export function createActionInvalidEventFromToolCall(input: {
  readonly state: ActionInvalidEventCoordinates;
  readonly toolCall: TypedToolCall<ToolSet>;
}): ActionInvalidStreamEvent {
  const toolError = (input.toolCall as { readonly error?: unknown }).error;
  const serializedInput = tryParseJsonValue(input.toolCall.input);

  return createActionInvalidEvent({
    callId: input.toolCall.toolCallId,
    errorText: toolError === undefined ? "Tool call is invalid." : toError(toolError).message,
    input: serializedInput,
    reason:
      toolError !== undefined && NoSuchToolError.isInstance(toolError)
        ? "no-such-tool"
        : "invalid-input",
    sequence: input.state.sequence,
    stepIndex: input.state.stepIndex,
    toolName: input.toolCall.toolName,
    turnId: input.state.turnId,
  });
}

/** Emits an invalid-action event once per tool-call id, optionally after flushing narration. */
export async function emitActionInvalidEvent(input: {
  readonly emitFn: (event: ActionInvalidStreamEvent) => Promise<void>;
  readonly emittedToolCallIds: Set<string>;
  readonly flushBeforeEmit?: () => Promise<void>;
  readonly state: ActionInvalidEventCoordinates;
  readonly toolCall: TypedToolCall<ToolSet>;
}): Promise<void> {
  if (input.emittedToolCallIds.has(input.toolCall.toolCallId)) {
    return;
  }

  await input.flushBeforeEmit?.();
  input.emittedToolCallIds.add(input.toolCall.toolCallId);
  await input.emitFn(
    createActionInvalidEventFromToolCall({
      state: input.state,
      toolCall: input.toolCall,
    }),
  );
}

function tryParseJsonValue(value: unknown): ReturnType<typeof parseJsonValue> | undefined {
  try {
    return parseJsonValue(value);
  } catch {
    return undefined;
  }
}
