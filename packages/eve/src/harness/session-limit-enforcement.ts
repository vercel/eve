/**
 * Session token limit policy for the tool-loop harness.
 *
 * Two seams into the harness step:
 *
 * 1. {@link applySessionLimitContinuation} runs after pending-input
 *    resolution and acts on the user's answer to a continuation prompt —
 *    grant a fresh budget window, or end the session.
 * 2. {@link enforceSessionTokenLimit} runs before each model call and, when
 *    the session is over budget, parks it on the deterministic continuation
 *    prompt (sessions that can reach a human) or fails it (task-mode sessions
 *    without HITL — nobody can answer the prompt).
 */
import type { ModelMessage } from "ai";

import {
  createInputRequestedEvent,
  createSessionCompletedEvent,
  createTurnCompletedEvent,
} from "#protocol/message.js";
import {
  emitFailedStep,
  emitTurnEpilogue,
  setHarnessEmissionState,
  type HarnessEmissionState,
} from "#harness/emission.js";
import { setPendingInputBatch } from "#harness/input-requests.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import {
  extendSessionTokenBudget,
  getSessionTokenLimitViolation,
  getSessionTokenUsage,
  type SessionTokenLimitViolation,
} from "#harness/turn-tag-state.js";
import type { HarnessSession, StepResult, ToolLoopHarnessConfig } from "#harness/types.js";

const SESSION_TOKEN_LIMIT_REACHED_CODE = "SESSION_TOKEN_LIMIT_REACHED";

interface SessionLimitPolicyInput {
  readonly config: ToolLoopHarnessConfig;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
}

/**
 * Acts on a resolved session-limit continuation answer.
 *
 * Granted: resets the token budget windows via
 * {@link extendSessionTokenBudget} and lets the step continue transparently.
 * Declined: a user decision, not an error — conversation sessions end
 * gracefully (`turn.completed` → `session.completed`, no extra copy; the
 * resolved prompt is the acknowledgment), while task mode keeps the
 * structured failure so the parent tool call receives an error result rather
 * than an empty success.
 *
 * Returns `result: null` when the step should continue with `session`.
 */
export async function applySessionLimitContinuation(
  input: SessionLimitPolicyInput & {
    readonly limitContinuation: { readonly granted: boolean } | undefined;
  },
): Promise<{ readonly result: StepResult | null; readonly session: HarnessSession }> {
  if (input.limitContinuation === undefined) {
    return { result: null, session: input.session };
  }

  if (input.limitContinuation.granted) {
    return { result: null, session: extendSessionTokenBudget(input.session) };
  }

  const violation = getSessionTokenLimitViolation(input.session);
  if (violation === null) {
    return { result: null, session: input.session };
  }

  if (input.config.mode === "task") {
    return {
      result: await failSessionTokenLimit({ ...input, violation }),
      session: input.session,
    };
  }

  if (input.emit) {
    await input.emit(
      createTurnCompletedEvent({
        sequence: input.emissionState.sequence,
        turnId: input.emissionState.turnId,
      }),
    );
    await input.emit(createSessionCompletedEvent());
  }

  return {
    result: { next: { done: true, output: "" }, session: input.session },
    session: input.session,
  };
}

/**
 * Pre-model-call gate for the session token budget.
 *
 * Returns `null` when the session is within budget. Over budget, sessions
 * that can reach a human park on the deterministic continuation prompt;
 * task-mode sessions without HITL fail fast with
 * `SESSION_TOKEN_LIMIT_REACHED`.
 */
export async function enforceSessionTokenLimit(
  input: SessionLimitPolicyInput & { readonly messages: readonly ModelMessage[] },
): Promise<StepResult | null> {
  const violation = getSessionTokenLimitViolation(input.session);
  if (violation === null) {
    return null;
  }

  const { emit } = input;
  if (
    emit !== undefined &&
    (input.config.mode === "conversation" || input.config.capabilities?.requestInput === true)
  ) {
    return parkOnSessionTokenLimit({ ...input, emit, violation });
  }

  return failSessionTokenLimit({ ...input, violation });
}

/**
 * Parks the session on the deterministic HITL continuation prompt. No model
 * call happens: the request is harness-authored, and the parked history
 * carries the step's accumulated messages so the triggering user message
 * survives into the resumed turn.
 */
async function parkOnSessionTokenLimit(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly emit: NonNullable<ToolLoopHarnessConfig["handleEvent"]>;
  readonly emissionState: HarnessEmissionState;
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
  readonly violation: SessionTokenLimitViolation;
}): Promise<StepResult> {
  const usage = getSessionTokenUsage(input.session);
  const request = createSessionLimitContinuationRequest({
    sessionId: input.session.sessionId,
    totalUsedTokens: input.violation.kind === "input" ? usage.inputTokens : usage.outputTokens,
    violation: input.violation,
  });
  let emissionState = input.emissionState;

  const parkedSession = setPendingInputBatch({
    event: {
      sequence: emissionState.sequence,
      stepIndex: emissionState.stepIndex,
      turnId: emissionState.turnId,
    },
    requests: [request],
    responseMessages: [],
    session: { ...input.session, history: [...input.messages] },
  });

  await input.emit(
    createInputRequestedEvent({
      requests: [request],
      sequence: emissionState.sequence,
      stepIndex: emissionState.stepIndex,
      turnId: emissionState.turnId,
    }),
  );

  if (input.config.mode === "conversation") {
    emissionState = await emitTurnEpilogue(
      input.emit,
      emissionState,
      input.config.mode,
      parkedSession.continuationToken,
    );
  }

  return {
    next: null,
    session: setHarnessEmissionState(parkedSession, emissionState),
  };
}

function formatSessionTokenLimitMessage(kind: SessionTokenLimitViolation["kind"]): string {
  return `The session reached its configured ${kind} token limit.`;
}

async function failSessionTokenLimit(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
  readonly violation: SessionTokenLimitViolation;
}): Promise<StepResult> {
  const usage = getSessionTokenUsage(input.session);
  const message = formatSessionTokenLimitMessage(input.violation.kind);
  const details = {
    inputTokens: usage.inputTokens,
    kind: input.violation.kind,
    limit: input.violation.limit,
    outputTokens: usage.outputTokens,
    usedTokens: input.violation.usedTokens,
  };

  if (input.emit) {
    await emitFailedStep(input.emit, input.emissionState, {
      code: SESSION_TOKEN_LIMIT_REACHED_CODE,
      details,
      message,
      sessionId: input.session.sessionId,
    });
  }

  return {
    next: {
      done: true,
      isError: input.config.mode === "task" ? true : undefined,
      output: input.config.mode === "task" ? message : "",
    },
    session: input.session,
  };
}
