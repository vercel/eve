import type {
  ModelMessage,
  TextStreamPart,
  ToolSet,
  TypedToolCall,
  TypedToolError,
  TypedToolResult,
} from "ai";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type InlineToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

import type { AssistantStepFinishReason } from "#protocol/message.js";
import {
  createActionsRequestedEvent,
  createActionInputAppendedEvent,
  createActionPartialEvent,
  createActionResultEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createReasoningAppendedEvent,
  createReasoningCompletedEvent,
} from "#protocol/message.js";
import { hasEmptyDeliverySentinel } from "#shared/empty-delivery.js";
import {
  createRuntimeToolResultFromStepResult,
  createRuntimeToolResultFromToolError,
  createToolResultMessagePartFromToolError,
} from "#harness/action-result-helpers.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/runtime-actions.js";
import {
  createInvalidToolCallInputError,
  isInvalidToolCall,
  resolveProviderToolCallRequest,
} from "#harness/tool-call-input-errors.js";
import type { RuntimeActionRequest, RuntimeToolResultActionResult } from "#shared/action-types.js";
import { createProviderStreamActionBatch } from "#harness/stream-actions.js";
import { normalizeModelStreamError } from "#harness/model-call-error.js";
import { createOrderedStreamEmitter } from "#harness/ordered-stream-emitter.js";
import { interruptStreamOnFailure } from "#harness/interruptible-stream.js";
import { isInlineAuthorizationToolResult } from "#harness/inline-tool-authorization.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import type { HarnessEmitFn, HarnessToolMap } from "#harness/types.js";

/**
 * Maps an AI SDK finish reason string to the eve-owned
 * {@link AssistantStepFinishReason} union. Unknown values become `"other"`.
 */
export function normalizeAssistantStepFinishReason(
  value: string | undefined,
): AssistantStepFinishReason {
  switch (value) {
    case "content-filter":
    case "error":
    case "length":
    case "stop":
    case "tool-calls":
      return value;
    default:
      return "other";
  }
}

/**
 * Result of consuming one step's `fullStream`.
 *
 * Inline results avoid duplicate post-step events. Approval-resume
 * authorization results also route back to the park detector.
 */
interface EmittedStreamContent {
  readonly emittedActionCallIds: ReadonlySet<string>;
  readonly handledInlineToolResultCallIds: ReadonlySet<string>;
  readonly invalidInputToolCallIds: ReadonlySet<string>;
  readonly inlineAuthorizationResults: readonly TypedToolResult<ToolSet>[];
  readonly trailingInlineToolResultParts: readonly InlineToolResultPart[];
}

interface StreamActionEmissionOptions {
  readonly excludedActionToolNames: ReadonlySet<string>;
  readonly tools: HarnessToolMap;
}

/** Consumes `fullStream` in source order, batching provider calls before their first result. */
export async function emitStreamContent(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
  options?: StreamActionEmissionOptions,
): Promise<EmittedStreamContent> {
  const orderedEmitter = createOrderedStreamEmitter(emitFn);
  const providerActionBatch = createProviderStreamActionBatch({
    emitFn: orderedEmitter.emit,
    state,
  });
  try {
    return await consumeStreamContent(
      orderedEmitter.emit,
      state,
      interruptStreamOnFailure(fullStream, orderedEmitter.failureSignal),
      providerActionBatch,
      options,
    );
  } finally {
    try {
      await providerActionBatch.cancel();
    } finally {
      await orderedEmitter.closeAndDrain();
    }
  }
}

async function consumeStreamContent(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
  providerActionBatch: ReturnType<typeof createProviderStreamActionBatch>,
  options?: StreamActionEmissionOptions,
): Promise<EmittedStreamContent> {
  let currentReasoning = "";
  let currentMessage = "";
  let finishReason: AssistantStepFinishReason = "stop";
  let streamError: Error | undefined;
  const toolCallIdsSeenInStream = new Set<string>();
  const emittedActionCallIds = new Set<string>();
  const emittedActionResultCallIds = new Set<string>();
  const providerToolCallIdsSeen = new Set<string>();
  const handledInlineToolResultCallIds = new Set<string>();
  const invalidInputToolCallIds = new Set<string>();
  const inlineAuthorizationResults: TypedToolResult<ToolSet>[] = [];
  const trailingInlineToolResultParts: InlineToolResultPart[] = [];
  const streamingActionInputs = new Map<string, { offset: number; toolName: string }>();

  const flushCurrentMessage = async (): Promise<void> => {
    if (currentMessage.length === 0) {
      return;
    }
    await emitFn(
      createMessageCompletedEvent({
        finishReason: "tool-calls",
        message: currentMessage,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
    currentMessage = "";
  };

  const emitActionInput = async (
    callId: string,
    toolName: string,
    inputTextDelta: string,
    inputTextOffset: number,
  ): Promise<void> =>
    emitFn(
      createActionInputAppendedEvent({
        callId,
        inputTextDelta,
        inputTextOffset,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        toolName,
        turnId: state.turnId,
      }),
    );

  const emitActionRequest = async (action: RuntimeActionRequest): Promise<void> => {
    if (emittedActionCallIds.has(action.callId)) {
      return;
    }

    if (currentMessage.trim().length > 0) {
      await flushCurrentMessage();
    }

    emittedActionCallIds.add(action.callId);
    await emitFn(
      createActionsRequestedEvent({
        actions: [action],
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  };

  const collectProviderToolCall = async (toolCall: {
    readonly input?: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  }): Promise<void> => {
    if (providerToolCallIdsSeen.has(toolCall.toolCallId)) {
      return;
    }
    providerToolCallIdsSeen.add(toolCall.toolCallId);
    if (emittedActionCallIds.has(toolCall.toolCallId)) {
      return;
    }
    emittedActionCallIds.add(toolCall.toolCallId);

    if (currentMessage.trim().length > 0) {
      await flushCurrentMessage();
    }

    const resolved = resolveProviderToolCallRequest(toolCall);
    if (resolved.toolError !== undefined) {
      invalidInputToolCallIds.add(toolCall.toolCallId);
      await emitActionResult(createRuntimeToolResultFromToolError(resolved.toolError));
      handledInlineToolResultCallIds.add(toolCall.toolCallId);
      trailingInlineToolResultParts.push(
        createToolResultMessagePartFromToolError(resolved.toolError),
      );
      return;
    }

    providerActionBatch.observe(resolved.request);
  };

  const emitActionResult = async (result: RuntimeToolResultActionResult): Promise<void> => {
    if (emittedActionResultCallIds.has(result.callId)) {
      return;
    }
    emittedActionResultCallIds.add(result.callId);
    await emitFn(
      createActionResultEvent({
        result,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  };

  const emitActionPartial = async (result: RuntimeToolResultActionResult): Promise<void> => {
    await emitFn(
      createActionPartialEvent({
        result,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  };

  const emitToolCall = async (toolCall: TypedToolCall<ToolSet>): Promise<void> => {
    if (isInvalidToolCall(toolCall)) {
      invalidInputToolCallIds.add(toolCall.toolCallId);
      return;
    }
    if (options === undefined || options.excludedActionToolNames.has(toolCall.toolName)) {
      return;
    }

    try {
      await emitActionRequest(
        createRuntimeActionRequestFromToolCall({
          toolCall,
          tools: options.tools,
        }),
      );
    } catch (error) {
      if (error instanceof TypeError) {
        const toolError = createInvalidToolCallInputError({ error, toolCall });
        invalidInputToolCallIds.add(toolCall.toolCallId);
        if (currentMessage.trim().length > 0) {
          await flushCurrentMessage();
        }
        await emitActionResult(createRuntimeToolResultFromToolError(toolError));
        handledInlineToolResultCallIds.add(toolCall.toolCallId);
        trailingInlineToolResultParts.push(createToolResultMessagePartFromToolError(toolError));
        return;
      }
      throw error;
    }
  };

  for await (const part of fullStream) {
    if (streamError !== undefined) {
      continue;
    }

    switch (part.type) {
      case "reasoning-delta":
        await providerActionBatch.flush();
        currentReasoning += part.text;
        await emitFn(
          createReasoningAppendedEvent({
            reasoningDelta: part.text,
            reasoningSoFar: currentReasoning,
            sequence: state.sequence,
            stepIndex: state.stepIndex,
            turnId: state.turnId,
          }),
        );
        break;
      case "text-delta":
        await providerActionBatch.flush();
        // Flush accumulated reasoning before text begins.
        if (currentReasoning.trim().length > 0) {
          await emitFn(
            createReasoningCompletedEvent({
              reasoning: currentReasoning,
              sequence: state.sequence,
              stepIndex: state.stepIndex,
              turnId: state.turnId,
            }),
          );
          currentReasoning = "";
        }
        currentMessage += part.text;
        await emitFn(
          createMessageAppendedEvent({
            messageDelta: part.text,
            messageSoFar: currentMessage,
            sequence: state.sequence,
            stepIndex: state.stepIndex,
            turnId: state.turnId,
          }),
        );
        break;
      case "tool-input-start": {
        if (
          options === undefined ||
          part.providerExecuted === true ||
          options.excludedActionToolNames.has(part.toolName)
        ) {
          streamingActionInputs.delete(part.id);
          break;
        }
        await providerActionBatch.flush();
        if (currentMessage.trim().length > 0) {
          await flushCurrentMessage();
        }
        streamingActionInputs.set(part.id, { offset: 0, toolName: part.toolName });
        await emitActionInput(part.id, part.toolName, "", 0);
        break;
      }
      case "tool-input-delta": {
        const input = streamingActionInputs.get(part.id);
        if (input === undefined) {
          break;
        }
        await providerActionBatch.flush();
        const inputTextOffset = input.offset;
        input.offset += part.delta.length;
        await emitActionInput(part.id, input.toolName, part.delta, inputTextOffset);
        break;
      }
      case "tool-input-end":
        streamingActionInputs.delete(part.id);
        break;
      case "tool-call": {
        const toolCall = part as TypedToolCall<ToolSet>;
        streamingActionInputs.delete(toolCall.toolCallId);
        toolCallIdsSeenInStream.add(toolCall.toolCallId);
        if (toolCall.providerExecuted === true) {
          await collectProviderToolCall(toolCall);
        } else {
          await providerActionBatch.flush();
          await emitToolCall(toolCall);
        }
        break;
      }
      case "tool-result": {
        const inlineToolResult = part as TypedToolResult<ToolSet>;
        if (inlineToolResult.preliminary === true) {
          if (inlineToolResult.providerExecuted !== true) {
            await emitActionPartial(createRuntimeToolResultFromStepResult(inlineToolResult));
          }
          break;
        }
        if (inlineToolResult.providerExecuted === true) {
          await collectProviderToolCall({
            input: "input" in inlineToolResult ? inlineToolResult.input : undefined,
            toolCallId: inlineToolResult.toolCallId,
            toolName: inlineToolResult.toolName,
          });
          await providerActionBatch.flush();
          await emitActionResult(createRuntimeToolResultFromStepResult(inlineToolResult));
          // Provider results already live in the assistant response. Do not
          // add a local tool message.
          break;
        }

        if (toolCallIdsSeenInStream.has(part.toolCallId)) {
          if (isInlineAuthorizationToolResult(inlineToolResult)) {
            break;
          }
          if (emittedActionCallIds.has(part.toolCallId)) {
            await emitActionResult(createRuntimeToolResultFromStepResult(inlineToolResult));
            handledInlineToolResultCallIds.add(part.toolCallId);
          }
          break;
        }

        // An approved tool can resume with its result but no matching call in
        // this step. Emit it before the message that consumes it.
        await providerActionBatch.flush();
        await flushCurrentMessage();
        if (isInlineAuthorizationToolResult(inlineToolResult)) {
          // Keep authorization output for the park detector instead of
          // emitting a normal tool result.
          handledInlineToolResultCallIds.add(part.toolCallId);
          inlineAuthorizationResults.push(inlineToolResult);
          break;
        }
        await emitActionResult(createRuntimeToolResultFromStepResult(inlineToolResult));
        handledInlineToolResultCallIds.add(part.toolCallId);
        break;
      }
      case "tool-error": {
        const toolError = part as TypedToolError<ToolSet>;
        if (toolError.providerExecuted === true) {
          await collectProviderToolCall(toolError);
          await providerActionBatch.flush();
          await emitActionResult(createRuntimeToolResultFromToolError(toolError));
        } else if (emittedActionCallIds.has(toolError.toolCallId)) {
          await emitActionResult(createRuntimeToolResultFromToolError(toolError));
          handledInlineToolResultCallIds.add(toolError.toolCallId);
          trailingInlineToolResultParts.push(createToolResultMessagePartFromToolError(toolError));
        }
        break;
      }
      case "finish-step":
        finishReason = normalizeAssistantStepFinishReason(part.finishReason);
        await providerActionBatch.flush();
        break;
      case "error":
        // `part.error` is typed as `unknown` — AI SDK providers emit
        // whatever the upstream service threw. Coerce through `toError`
        // so plain-object shapes (structured-clone survivors, typed
        // gateway payloads) keep their `message`, `name`, `stack`, and
        // `cause` instead of degrading to `new Error("[object Object]")`.
        streamError = normalizeModelStreamError(part.error);
        break;
      case "abort":
        // The SDK does not resolve step results for aborted in-flight steps.
        throw new DOMException(part.reason ?? "The model stream was aborted.", "AbortError");
      default:
        break;
    }
  }

  await providerActionBatch.flush();

  if (streamError !== undefined) {
    throw streamError;
  }

  // Flush remaining reasoning.
  if (currentReasoning.trim().length > 0) {
    await emitFn(
      createReasoningCompletedEvent({
        reasoning: currentReasoning,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  }

  // Channel adapters deliver terminal completions, so the reserved marker
  // becomes a null completion without delaying normal streaming deltas.
  if (finishReason !== "tool-calls" && hasEmptyDeliverySentinel(currentMessage)) {
    await emitFn(
      createMessageCompletedEvent({
        finishReason,
        message: null,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  } else if (currentMessage.trim().length > 0) {
    await emitFn(
      createMessageCompletedEvent({
        finishReason,
        message: currentMessage,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  }

  return {
    emittedActionCallIds,
    handledInlineToolResultCallIds,
    invalidInputToolCallIds,
    inlineAuthorizationResults,
    trailingInlineToolResultParts,
  };
}
