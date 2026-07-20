/**
 * Consumes one model step's AI SDK `fullStream` and emits the real-time
 * runtime events it implies: text and reasoning deltas, `action.preparing`
 * announcements while a call's input still streams, per-call
 * `actions.requested`, and inline tool results. Split from
 * `#harness/emission.js`, which keeps the emission state and the
 * turn/step lifecycle cascades; the tool loop is the only consumer.
 */

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

import {
  createActionPreparingEvent,
  createActionsRequestedEvent,
  createActionResultEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createReasoningAppendedEvent,
  createReasoningCompletedEvent,
} from "#protocol/message.js";
import type { AssistantStepFinishReason } from "#protocol/message.js";
import { hasEmptyDeliverySentinel } from "#shared/empty-delivery.js";
import {
  createRuntimeToolResultFromStepResult,
  createRuntimeToolResultFromToolError,
  createToolResultMessagePartFromToolError,
} from "#harness/action-result-helpers.js";
import {
  createRuntimeActionRequestFromToolCall,
  resolveToolCallInputObject,
} from "#harness/runtime-actions.js";
import { createInvalidToolCallInputError } from "#harness/tool-call-input-errors.js";
import type {
  RuntimeActionRequest,
  RuntimeToolResultActionResult,
} from "#runtime/actions/types.js";
import { createProviderStreamActionBatch } from "#harness/stream-actions.js";
import { normalizeModelStreamError } from "#harness/model-call-error.js";
import { createOrderedStreamEmitter } from "#harness/ordered-stream-emitter.js";
import { interruptStreamOnFailure } from "#harness/interruptible-stream.js";
import { isInlineAuthorizationToolResult } from "#harness/inline-tool-authorization.js";
import {
  normalizeAssistantStepFinishReason,
  type HarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessEmitFn, HarnessToolMap } from "#harness/types.js";

// ---------------------------------------------------------------------------
// Stream content emission
// ---------------------------------------------------------------------------

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

/**
 * Consumes the AI SDK `fullStream` and emits real-time text and reasoning
 * events.
 *
 * Emits local tool events in source order. Provider calls that arrive in one
 * stream batch into one request event before their first result. A result
 * without a streamed call resumes a call from an earlier step.
 */
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
  const announcedPreparingCallIds = new Set<string>();
  const emittedActionCallIds = new Set<string>();
  const emittedActionResultCallIds = new Set<string>();
  const providerToolCallIdsSeen = new Set<string>();
  const handledInlineToolResultCallIds = new Set<string>();
  const invalidInputToolCallIds = new Set<string>();
  const inlineAuthorizationResults: TypedToolResult<ToolSet>[] = [];
  const trailingInlineToolResultParts: InlineToolResultPart[] = [];

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

    providerActionBatch.observe({
      callId: toolCall.toolCallId,
      input: resolveToolCallInputObject(toolCall.input, {
        callId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }),
      kind: "tool-call",
      toolName: toolCall.toolName,
    });
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

  const emitToolCall = async (toolCall: TypedToolCall<ToolSet>): Promise<void> => {
    if (
      options === undefined ||
      toolCall.invalid === true ||
      options.excludedActionToolNames.has(toolCall.toolName)
    ) {
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
      case "tool-input-start":
        // The model has committed to this call; its input is still streaming.
        // Announcing the (callId, toolName) pair now lets consumers surface
        // the upcoming call during the otherwise event-less generation window.
        // The part's `id` is the tool call id of the later `tool-call` part.
        if (emittedActionCallIds.has(part.id)) break;
        if (announcedPreparingCallIds.has(part.id)) break;
        announcedPreparingCallIds.add(part.id);
        await emitFn(
          createActionPreparingEvent({
            callId: part.id,
            sequence: state.sequence,
            stepIndex: state.stepIndex,
            toolName: part.toolName,
            turnId: state.turnId,
          }),
        );
        break;
      case "tool-call": {
        const toolCall = part as TypedToolCall<ToolSet>;
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
        // Preliminary chunks can be superseded by the terminal result.
        if (inlineToolResult.preliminary === true) {
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
