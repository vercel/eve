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

import type {
  AssistantStepFinishReason,
  RuntimeIdentity,
  RuntimeTraceContext,
} from "#protocol/message.js";
import {
  createActionsRequestedEvent,
  createActionInputAppendedEvent,
  createActionPartialEvent,
  createActionResultEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createReasoningAppendedEvent,
  createReasoningCompletedEvent,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionStartedEvent,
  createSessionWaitingEvent,
  createStepFailedEvent,
  createStepStartedEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import type { RunMode } from "#shared/run-mode.js";
import { hasEmptyDeliverySentinel } from "#shared/empty-delivery.js";
import type { JsonObject } from "#shared/json.js";
import {
  createRuntimeToolResultFromStepResult,
  createRuntimeToolResultFromToolError,
  createToolResultMessagePartFromToolError,
} from "#harness/action-result-helpers.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/coordination.js";
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
import type {
  HandleSettlementFn,
  HarnessEmitFn,
  HarnessToolMap,
  StepInput,
} from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

export {
  getHarnessEmissionState,
  isHarnessBetweenTurns,
  setHarnessEmissionState,
} from "#harness/emission-state.js";
export type { HarnessEmissionState } from "#harness/emission-state.js";

// ---------------------------------------------------------------------------
// Turn lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Emits `session.started` (once), `turn.started`, and `message.received` at the
 * beginning of a new turn. Returns updated emission state.
 */
export async function emitTurnPreamble(
  emitFn: HarnessEmitFn,
  input: StepInput,
  state: HarnessEmissionState,
  runtimeIdentity?: RuntimeIdentity,
  traceContext?: RuntimeTraceContext,
): Promise<HarnessEmissionState> {
  const turnId = state.nextTurnId ?? `turn_${state.sequence}`;

  if (!state.sessionStarted) {
    await emitFn(createSessionStartedEvent({ runtime: runtimeIdentity, trace: traceContext }));
  }

  await emitFn(createTurnStartedEvent({ sequence: state.sequence, trace: traceContext, turnId }));

  if (input.message !== undefined) {
    await emitFn(
      createMessageReceivedEvent({
        message: input.message,
        sequence: state.sequence,
        turnId,
      }),
    );
  }

  return {
    sessionStarted: true,
    sequence: state.sequence,
    stepIndex: 0,
    turnId,
  };
}

/**
 * Emits `step.started` for one model call.
 */
export async function emitStepStarted(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  modelId: string,
  messages?: readonly import("ai").ModelMessage[],
): Promise<void> {
  await emitFn(
    createStepStartedEvent({
      modelId,
      sequence: state.sequence,
      stepIndex: state.stepIndex,
      turnId: state.turnId,
    }),
    messages,
  );
}

interface FailedStepPayload {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
}

/**
 * Emits the shared head of both failure cascades: `step.failed` →
 * `turn.failed`. Both terminal and recoverable paths diverge only on
 * the third event (`session.failed` vs. `session.waiting`).
 */
function failedStepEvents(
  state: HarnessEmissionState,
  input: FailedStepPayload,
): UnstampedMessageStreamEvent[] {
  return [
    createStepFailedEvent({
      ...input,
      sequence: state.sequence,
      stepIndex: state.stepIndex,
      turnId: state.turnId,
    }),
    createTurnFailedEvent({
      ...input,
      sequence: state.sequence,
      turnId: state.turnId,
    }),
  ];
}

/**
 * Emits the full terminal failure cascade: `step.failed` →
 * `turn.failed` → `session.failed`.
 *
 * Use this when the session cannot be salvaged (structural config
 * error, auth misconfig, non-recoverable provider response). The
 * `session.failed` tail tells adapters the session is dead and no
 * further follow-up is possible on the same continuation token.
 */
export async function emitFailedStep(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload & { readonly sessionId: string },
  handleSettlement?: HandleSettlementFn,
): Promise<void> {
  await settleEmission(
    emitFn,
    state,
    [...failedStepEvents(state, input), createSessionFailedEvent(input)],
    handleSettlement,
  );
}

/**
 * Emits the recoverable failure cascade: `step.failed` →
 * `turn.failed` → `session.waiting`.
 */
export async function emitRecoverableFailedTurn(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload & { readonly continuationToken: string },
  handleSettlement?: HandleSettlementFn,
): Promise<HarnessEmissionState> {
  return settleEmission(
    emitFn,
    state,
    [...failedStepEvents(state, input), createSessionWaitingEvent()],
    handleSettlement,
  );
}

/**
 * Returns updated emission state for the next step in the current turn.
 */
export function advanceStep(state: HarnessEmissionState): HarnessEmissionState {
  return {
    ...state,
    stepIndex: state.stepIndex + 1,
  };
}

/**
 * Emits `turn.completed` and either `session.waiting` or `session.completed`.
 * Returns updated emission state with an incremented sequence.
 */
export async function emitTurnEpilogue(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  mode: RunMode,
  handleSettlement?: HandleSettlementFn,
  precedingEvents: readonly UnstampedMessageStreamEvent[] = [],
): Promise<HarnessEmissionState> {
  return settleEmission(
    emitFn,
    state,
    [
      ...precedingEvents,
      createTurnCompletedEvent({
        sequence: state.sequence,
        turnId: state.turnId,
      }),
      mode === "conversation" ? createSessionWaitingEvent() : createSessionCompletedEvent(),
    ],
    handleSettlement,
  );
}

async function settleEmission(
  emit: HarnessEmitFn,
  before: HarnessEmissionState,
  events: readonly UnstampedMessageStreamEvent[],
  handleSettlement?: HandleSettlementFn,
): Promise<HarnessEmissionState> {
  const emissionAfter: HarnessEmissionState = {
    sessionStarted: before.sessionStarted,
    sequence: before.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
  if (handleSettlement !== undefined) {
    await handleSettlement({ events, emissionAfter });
    return before;
  }
  for (const event of events) await emit(event);
  return emissionAfter;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

function readSubagentBackgroundTaskReceipt(
  result: RuntimeToolResultActionResult,
  tools: HarnessToolMap | undefined,
): { readonly status: "working"; readonly taskId: string } | undefined {
  if (result.isError === true || tools?.get(result.toolName)?.resultKind !== "subagent") {
    return undefined;
  }
  if (typeof result.output !== "object" || result.output === null || Array.isArray(result.output)) {
    return undefined;
  }
  const status = Reflect.get(result.output, "status");
  const taskId = Reflect.get(result.output, "taskId");
  return status === "working" && typeof taskId === "string" ? { status, taskId } : undefined;
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
  const emittedActionCallIds = new Set<string>();
  const emittedActionResultCallIds = new Set<string>();
  const providerToolCallIdsSeen = new Set<string>();
  const handledInlineToolResultCallIds = new Set<string>();
  const invalidInputToolCallIds = new Set<string>();
  const inlineAuthorizationResults: TypedToolResult<ToolSet>[] = [];
  const trailingInlineToolResultParts: InlineToolResultPart[] = [];
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
  ): Promise<void> =>
    emitFn(
      createActionInputAppendedEvent({
        callId,
        inputTextDelta,
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
    const backgroundTask = readSubagentBackgroundTaskReceipt(result, options?.tools);
    if (backgroundTask !== undefined) {
      await emitFn({
        data: {
          backgroundTask,
          callId: result.callId,
          output: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
          subagentName: result.toolName,
        },
        type: "subagent.completed",
      });
    }
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
