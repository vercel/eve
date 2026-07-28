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

import type { AssistantStepFinishReason, RuntimeIdentity } from "#protocol/message.js";
import {
  createActionsRequestedEvent,
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
import type {
  HarnessEmitFn,
  HarnessSession,
  HarnessToolMap,
  SessionStateMap,
  StepInput,
} from "#harness/types.js";

// ---------------------------------------------------------------------------
// Emission state
// ---------------------------------------------------------------------------

/**
 * Tracks emission lifecycle state across harness step invocations.
 *
 * Persisted on `session.state` so the state survives when the durable
 * workflow runtime recreates the harness at each `"use step"` boundary.
 */
export interface HarnessEmissionState {
  readonly sessionStarted: boolean;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

const HARNESS_EMISSION_STATE_KEY = "eve.harness.emission";

const DEFAULT_EMISSION_STATE: HarnessEmissionState = {
  sessionStarted: false,
  sequence: 0,
  stepIndex: 0,
  turnId: "",
};

/** Reads the emission state, returning defaults when absent. */
export function getHarnessEmissionState(state: SessionStateMap | undefined): HarnessEmissionState {
  const emissionState = state?.[HARNESS_EMISSION_STATE_KEY] as HarnessEmissionState | undefined;
  return emissionState ?? DEFAULT_EMISSION_STATE;
}

/**
 * Returns `true` when the harness is **between turns** — either no turn
 * has started yet (initial state) or the previous turn has emitted its
 * epilogue (or recoverable failure cascade) and reset.
 *
 * Returns `false` while a turn is in progress, including during
 * tool-loop continuations and runtime-action resumes within the same
 * turn. Callers that gate per-turn work (eg. lifecycle hook dispatch)
 * use this predicate to distinguish a fresh delivery from a
 * continuation of an in-flight turn.
 *
 * Implemented over the empty-`turnId` sentinel that `emitTurnEpilogue`
 * and `emitRecoverableFailedTurn` write — clients should never read
 * `state.turnId` directly to make this distinction.
 */
export function isHarnessBetweenTurns(session: HarnessSession): boolean {
  return getHarnessEmissionState(session.state).turnId === "";
}

/**
 * Writes the emission state onto a new copy of the session.
 */
export function setHarnessEmissionState(
  session: HarnessSession,
  state: HarnessEmissionState,
): HarnessSession {
  return {
    ...session,
    state: {
      ...session.state,
      [HARNESS_EMISSION_STATE_KEY]: state,
    },
  };
}

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
): Promise<HarnessEmissionState> {
  const turnId = `turn_${state.sequence}`;

  if (!state.sessionStarted) {
    await emitFn(createSessionStartedEvent({ runtime: runtimeIdentity }));
  }

  await emitFn(createTurnStartedEvent({ sequence: state.sequence, turnId }));

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
  messages?: readonly import("ai").ModelMessage[],
): Promise<void> {
  await emitFn(
    createStepStartedEvent({
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
async function emitStepAndTurnFailed(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload,
): Promise<void> {
  await emitFn(
    createStepFailedEvent({
      ...input,
      sequence: state.sequence,
      stepIndex: state.stepIndex,
      turnId: state.turnId,
    }),
  );
  await emitFn(
    createTurnFailedEvent({
      ...input,
      sequence: state.sequence,
      turnId: state.turnId,
    }),
  );
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
): Promise<void> {
  await emitStepAndTurnFailed(emitFn, state, input);
  await emitFn(createSessionFailedEvent(input));
}

/**
 * Emits the recoverable failure cascade: `step.failed` →
 * `turn.failed` → `session.waiting`.
 */
export async function emitRecoverableFailedTurn(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload & { readonly continuationToken: string },
): Promise<HarnessEmissionState> {
  await emitStepAndTurnFailed(emitFn, state, input);
  await emitFn(createSessionWaitingEvent(input.continuationToken));

  return {
    sessionStarted: state.sessionStarted,
    sequence: state.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
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
  continuationToken: string,
): Promise<HarnessEmissionState> {
  await emitFn(
    createTurnCompletedEvent({
      sequence: state.sequence,
      turnId: state.turnId,
    }),
  );

  if (mode === "conversation") {
    await emitFn(createSessionWaitingEvent(continuationToken));
  } else {
    await emitFn(createSessionCompletedEvent());
  }

  return {
    sessionStarted: state.sessionStarted,
    sequence: state.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
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
