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
type InlineToolResultJsonValue = Extract<InlineToolResultPart["output"], { type: "json" }>["value"];

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
import { toError } from "#shared/errors.js";
import type { JsonObject } from "#shared/json.js";
import {
  createRuntimeToolResultFromStepResult,
  createRuntimeToolResultFromValue,
} from "#harness/action-result-helpers.js";
import { resolveToolCallInputObject } from "#harness/runtime-actions.js";
import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import { isAuthorizationSignal, isPendingAuthorizationToolOutput } from "#harness/authorization.js";
import { contextStorage } from "#context/container.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";
import type { HarnessEmitFn, HarnessSession, SessionStateMap, StepInput } from "#harness/types.js";

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
  input: FailedStepPayload,
): Promise<HarnessEmissionState> {
  await emitStepAndTurnFailed(emitFn, state, input);
  await emitFn(createSessionWaitingEvent());

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
): Promise<HarnessEmissionState> {
  await emitFn(
    createTurnCompletedEvent({
      sequence: state.sequence,
      turnId: state.turnId,
    }),
  );

  if (mode === "conversation") {
    await emitFn(createSessionWaitingEvent());
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
 * `handledInlineToolResultCallIds` lists approval-resume tool-result
 * call ids the stream already handled inline — either emitted as
 * `action.result` events or routed to the authorization park path.
 * `emitStepActions` skips these to avoid double-emission.
 *
 * `inlineToolResultParts` holds the same tool-results in
 * `ToolResultPart` shape. The AI SDK omits them from
 * `stepResult.response.messages` on the approval-resume path, so the
 * harness splices them into persisted history to keep the prior turn's
 * `tool_use` block balanced with a matching `tool_result` on replay.
 *
 * `inlineAuthorizationResults` holds approval-resume tool-results whose
 * output is an {@link AuthorizationSignal}. These are surfaced into
 * `stepResult.toolResults` for the park detector instead of being emitted
 * as plain `action.result` events.
 */
interface EmittedStreamContent {
  readonly handledInlineToolResultCallIds: ReadonlySet<string>;
  readonly inlineAuthorizationResults: readonly TypedToolResult<ToolSet>[];
  readonly inlineToolResultParts: readonly InlineToolResultPart[];
}

/**
 * Consumes the AI SDK `fullStream` and emits real-time text and reasoning
 * events.
 *
 * `tool-result` parts that have no preceding `tool-call` in this stream
 * are emitted inline as `action.result` events. This is the
 * approval-resume path: when a previously-parked tool call is approved,
 * the AI SDK enqueues the executed tool-result onto the same step's
 * stream before the next LLM call. Emitting `action.result` inline keeps
 * it ahead of the message events that depend on it.
 *
 * Tool-call, tool-approval-request, and non-resumed tool-result events
 * are still emitted by `emitStepActions` from the `onStepFinish`
 * callback so the existing single-step batch ordering is preserved.
 */
export async function emitStreamContent(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
): Promise<EmittedStreamContent> {
  let currentReasoning = "";
  let currentMessage = "";
  let finishReason: AssistantStepFinishReason = "stop";
  let streamError: Error | undefined;
  const toolCallIdsSeenInStream = new Set<string>();
  const emittedProviderToolCallIds = new Set<string>();
  const handledInlineToolResultCallIds = new Set<string>();
  const inlineAuthorizationResults: TypedToolResult<ToolSet>[] = [];
  const inlineToolResultParts: InlineToolResultPart[] = [];

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

  const emitProviderToolCall = async (toolCall: {
    readonly input?: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  }): Promise<void> => {
    if (emittedProviderToolCallIds.has(toolCall.toolCallId)) {
      return;
    }

    emittedProviderToolCallIds.add(toolCall.toolCallId);
    const action = {
      callId: toolCall.toolCallId,
      input: resolveToolCallInputObject(toolCall.input, {
        callId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }),
      kind: "tool-call",
      toolName: toolCall.toolName,
    } satisfies RuntimeToolCallActionRequest;
    await emitFn(
      createActionsRequestedEvent({
        actions: [action],
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  };

  for await (const part of fullStream) {
    if (streamError !== undefined) {
      continue;
    }

    switch (part.type) {
      case "reasoning-delta":
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
          await emitProviderToolCall(toolCall);
        }
        break;
      }
      case "tool-result": {
        const inlineToolResult = part as TypedToolResult<ToolSet>;
        if (inlineToolResult.providerExecuted === true) {
          await emitProviderToolCall({
            input: "input" in inlineToolResult ? inlineToolResult.input : undefined,
            toolCallId: inlineToolResult.toolCallId,
            toolName: inlineToolResult.toolName,
          });
          await emitFn(
            createActionResultEvent({
              result: createRuntimeToolResultFromStepResult(inlineToolResult),
              sequence: state.sequence,
              stepIndex: state.stepIndex,
              turnId: state.turnId,
            }),
          );
          // Provider-executed results are already kept in the provider-owned
          // assistant response shape. Do not synthesize local `role: "tool"`
          // history for them; just surface the normal action result above.
          break;
        }

        // Approval-resume: the AI SDK enqueues a previously-parked
        // tool's result onto the parent stream before re-entering the
        // LLM call. The tool-call itself was emitted on a prior step's
        // stream, so it is absent here. Surface `action.result`
        // inline so it precedes the message events that consume it.
        if (toolCallIdsSeenInStream.has(part.toolCallId)) {
          break;
        }
        await flushCurrentMessage();
        if (isInlineAuthorizationToolResult(inlineToolResult)) {
          // Approval-resume auth: route to the park detector via
          // inlineAuthorizationResults instead of emitting a plain
          // action.result that the model would treat as a normal output.
          handledInlineToolResultCallIds.add(part.toolCallId);
          inlineAuthorizationResults.push(inlineToolResult);
          break;
        }
        await emitFn(
          createActionResultEvent({
            result: createRuntimeToolResultFromStepResult(inlineToolResult),
            sequence: state.sequence,
            stepIndex: state.stepIndex,
            turnId: state.turnId,
          }),
        );
        handledInlineToolResultCallIds.add(part.toolCallId);
        // Match AI SDK's `createToolModelOutput` shape (json for non-strings,
        // text for strings) so persisted history is shape-compatible.
        const rawOutput: unknown = inlineToolResult.output;
        inlineToolResultParts.push({
          type: "tool-result",
          toolCallId: inlineToolResult.toolCallId,
          toolName: inlineToolResult.toolName,
          output:
            typeof rawOutput === "string"
              ? { type: "text", value: rawOutput }
              : { type: "json", value: (rawOutput ?? null) as InlineToolResultJsonValue },
        });
        break;
      }
      case "tool-error": {
        const toolError = part as TypedToolError<ToolSet>;
        if (toolError.providerExecuted === true) {
          await emitProviderToolCall(toolError);
          await emitFn(
            createActionResultEvent({
              result: createRuntimeToolResultFromValue({
                callId: toolError.toolCallId,
                isError: true,
                output: toError(toolError.error),
                toolName: toolError.toolName,
              }),
              sequence: state.sequence,
              stepIndex: state.stepIndex,
              turnId: state.turnId,
            }),
          );
        }
        break;
      }
      case "finish-step":
        finishReason = normalizeAssistantStepFinishReason(part.finishReason);
        break;
      case "error":
        // `part.error` is typed as `unknown` — AI SDK providers emit
        // whatever the upstream service threw. Coerce through `toError`
        // so plain-object shapes (structured-clone survivors, typed
        // gateway payloads) keep their `message`, `name`, `stack`, and
        // `cause` instead of degrading to `new Error("[object Object]")`.
        streamError = toError(part.error);
        break;
      default:
        break;
    }
  }

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

  // Flush remaining text.
  if (currentMessage.length > 0) {
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

  return { handledInlineToolResultCallIds, inlineAuthorizationResults, inlineToolResultParts };
}

function isInlineAuthorizationToolResult(toolResult: TypedToolResult<ToolSet>): boolean {
  if (isPendingAuthorizationToolOutput(toolResult.output)) {
    return true;
  }
  const ctx = contextStorage.getStore();
  if (ctx === undefined) {
    return false;
  }
  const stashed = readToolInterrupt(ctx, toolResult.toolCallId);
  return stashed !== undefined && isAuthorizationSignal(stashed);
}
