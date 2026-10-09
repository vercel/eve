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
  createActionResultEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createReasoningAppendedEvent,
  createReasoningCompletedEvent,
} from "#protocol/message.js";
import type { JsonObject } from "#shared/json.js";
import {
  createRuntimeToolResultFromStepResult,
  createRuntimeToolResultFromToolError,
  toActionResult,
  createToolResultMessagePartFromToolError,
} from "#harness/action-result-helpers.js";
import {
  createInvalidToolCallInputError,
  isInvalidToolCall,
  resolveProviderToolCallRequest,
} from "#harness/tool-call-input-errors.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import {
  collectActionPresentation,
  createPresentedRuntimeActionRequestFromToolCall,
  type RuntimeActionRequestProjection,
} from "#harness/action-presentation.js";
import { projectResultPresentation } from "#harness/tool-presentation.js";
import { createProviderStreamActionBatch } from "#harness/stream-actions.js";
import { normalizeModelStreamError } from "#harness/model-call/errors.js";
import { createOrderedStreamEmitter } from "#harness/ordered-stream-emitter.js";
import { interruptStreamOnFailure } from "#harness/interruptible-stream.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import type { HarnessEmitFn, HarnessToolLookup } from "#harness/types.js";
import { normalizeAssistantStepFinishReason } from "#harness/finish-reason.js";

/** The calls of one step's `fullStream` whose input was invalid, and their results. */
interface EmittedStreamContent {
  readonly invalidInputToolCallIds: ReadonlySet<string>;
  readonly trailingInlineToolResultParts: readonly InlineToolResultPart[];
}

interface StreamActionEmissionOptions {
  readonly excludedActionToolNames: ReadonlySet<string>;
  /**
   * A child's or schedule's turn is held while its tasks work, so a text step
   * can't end it: the step reports `"tool-calls"` and channels don't post it
   * as the reply.
   */
  readonly hidesHeldText?: boolean;
  readonly tools: HarnessToolLookup;
  readonly unsettledActionToolNames?: Map<string, string>;
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
  state: TurnPosition,
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
  options?: StreamActionEmissionOptions,
): Promise<EmittedStreamContent> {
  const orderedEmitter = createOrderedStreamEmitter(emitFn);
  const providerActionBatch = createProviderStreamActionBatch({
    emitFn: orderedEmitter.emit,
    onActionsEmitted: (actions) => {
      for (const { request, toolName } of actions) {
        options?.unsettledActionToolNames?.set(request.action.callId, toolName);
      }
    },
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

/** A hidden held turn's text step isn't its reply, so it reports `"tool-calls"` as channels expect. */
function reportedFinishReason(
  finishReason: AssistantStepFinishReason,
  hidesHeldText: boolean,
): AssistantStepFinishReason {
  if (hidesHeldText && finishReason === "stop") return "tool-calls";
  return finishReason;
}

async function consumeStreamContent(
  emitFn: HarnessEmitFn,
  state: TurnPosition,
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
  providerActionBatch: ReturnType<typeof createProviderStreamActionBatch>,
  options?: StreamActionEmissionOptions,
): Promise<EmittedStreamContent> {
  let currentReasoning = "";
  let currentMessage = "";
  let finishReason: AssistantStepFinishReason = "stop";
  let streamError: Error | undefined;
  const emittedActionCallIds = new Set<string>();
  const emittedActionResultCallIds = new Set<string>();
  const providerToolCallIdsSeen = new Set<string>();
  const invalidInputToolCallIds = new Set<string>();
  const trailingInlineToolResultParts: InlineToolResultPart[] = [];
  const actionInputs = new Map<string, JsonObject>();
  const streamingActionInputs = new Map<string, { toolName: string }>();

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
  ): Promise<void> => {
    await emitFn(
      createActionInputAppendedEvent({
        callId,
        inputTextDelta,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        toolName,
        turnId: state.turnId,
      }),
    );
    options?.unsettledActionToolNames?.set(callId, toolName);
  };

  const emitActionRequest = async (
    projection: RuntimeActionRequestProjection,
    toolName: string,
  ): Promise<void> => {
    const { action } = projection;
    if (emittedActionCallIds.has(action.callId)) {
      return;
    }

    if (currentMessage.trim().length > 0) {
      await flushCurrentMessage();
    }

    emittedActionCallIds.add(action.callId);
    actionInputs.set(action.callId, action.input);
    await emitFn(
      createActionsRequestedEvent({
        actions: [action],
        presentation: collectActionPresentation([projection]),
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
    options?.unsettledActionToolNames?.set(action.callId, toolName);
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

    const resolved = resolveProviderToolCallRequest(toolCall, options?.tools ?? new Map());
    if (resolved.toolError !== undefined) {
      invalidInputToolCallIds.add(toolCall.toolCallId);
      await emitActionResult(createRuntimeToolResultFromToolError(resolved.toolError));
      trailingInlineToolResultParts.push(
        createToolResultMessagePartFromToolError(resolved.toolError),
      );
      return;
    }

    actionInputs.set(resolved.request.action.callId, resolved.request.action.input);
    providerActionBatch.observe(resolved.request, toolCall.toolName);
  };

  const emitActionResult = async (result: RuntimeToolResultActionResult): Promise<void> => {
    if (emittedActionResultCallIds.has(result.callId)) {
      return;
    }
    emittedActionResultCallIds.add(result.callId);
    const resultPresentation =
      result.isError === true
        ? undefined
        : projectResultPresentation(
            options?.tools.get(result.toolName),
            result.callId,
            actionInputs.get(result.callId),
            result.output,
          );
    await emitFn(
      createActionResultEvent({
        presentation: resultPresentation,
        result: toActionResult(result, actionInputs.get(result.callId)),
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
    options?.unsettledActionToolNames?.delete(result.callId);
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
        createPresentedRuntimeActionRequestFromToolCall({
          toolCall,
          tools: options.tools,
        }),
        toolCall.toolName,
      );
    } catch (error) {
      if (error instanceof TypeError) {
        const toolError = createInvalidToolCallInputError({ error, toolCall });
        invalidInputToolCallIds.add(toolCall.toolCallId);
        if (currentMessage.trim().length > 0) {
          await flushCurrentMessage();
        }
        await emitActionResult(createRuntimeToolResultFromToolError(toolError));
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
        streamingActionInputs.set(part.id, { toolName: part.toolName });
        break;
      }
      case "tool-input-delta": {
        const input = streamingActionInputs.get(part.id);
        if (input === undefined) {
          break;
        }
        await providerActionBatch.flush();
        await emitActionInput(part.id, input.toolName, part.delta);
        break;
      }
      case "tool-input-end":
        streamingActionInputs.delete(part.id);
        break;
      case "tool-call": {
        const toolCall = part as TypedToolCall<ToolSet>;
        streamingActionInputs.delete(toolCall.toolCallId);
        if (toolCall.providerExecuted === true) {
          await collectProviderToolCall(toolCall);
        } else {
          await providerActionBatch.flush();
          await emitToolCall(toolCall);
        }
        break;
      }
      // eve runs local calls after the stream, so only the provider's own results and errors
      // arrive here.
      case "tool-result": {
        const providerResult = part as TypedToolResult<ToolSet>;
        if (providerResult.providerExecuted !== true || providerResult.preliminary === true) break;
        await collectProviderToolCall({
          input: "input" in providerResult ? providerResult.input : undefined,
          toolCallId: providerResult.toolCallId,
          toolName: providerResult.toolName,
        });
        await providerActionBatch.flush();
        await emitActionResult(createRuntimeToolResultFromStepResult(providerResult));
        break;
      }
      case "tool-error": {
        const toolError = part as TypedToolError<ToolSet>;
        if (toolError.providerExecuted !== true) break;
        await collectProviderToolCall(toolError);
        await providerActionBatch.flush();
        await emitActionResult(createRuntimeToolResultFromToolError(toolError));
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

  if (finishReason !== "content-filter" && currentMessage.trim().length > 0) {
    await emitFn(
      createMessageCompletedEvent({
        finishReason: reportedFinishReason(finishReason, options?.hidesHeldText === true),
        message: currentMessage,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  }

  return { invalidInputToolCallIds, trailingInlineToolResultParts };
}
