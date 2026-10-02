/**
 * Session token and token-cost budget for the tool-loop harness, at two points in a step:
 *
 * 1. {@link applyBudgetAnswer} acts on the answer to a continuation prompt once its turn opens:
 *    a fresh budget window, or cancelling the in-flight turn tree.
 * 2. {@link enforceBudget} runs before each model call and, when the session is over budget,
 *    parks it on the continuation prompt (sessions that can request input) or fails it.
 */
import { createInputRequestedEvent } from "#protocol/message.js";
import { emitFailedStep, emitTurnEpilogue } from "#harness/emission.js";
import { appendPendingInputBatch } from "#harness/input-requests.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { Step } from "#harness/step/context.js";
import { SessionLimitDeclinedError } from "#harness/turn-cancellation.js";
import {
  bumpSessionRuntimeUsageLimits,
  getSessionUsageLimitViolation,
  getSessionTokenUsage,
  getSessionUsage,
  type SessionUsageLimitViolation,
} from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";
import { createSessionLimitContinuationRequest } from "./budget-request.js";

const SESSION_TOKEN_LIMIT_REACHED_CODE = "SESSION_TOKEN_LIMIT_REACHED";
const SESSION_TOKEN_COST_LIMIT_REACHED_CODE = "SESSION_TOKEN_COST_LIMIT_REACHED";

/**
 * Acts on a resolved continuation answer. Granted: the runtime token limits bump and the step
 * continues. Declined: a user decision, not an error. The decline cancels the in-flight turn tree
 * through the standard cancellation path, settling as `turn.cancelled` then `session.waiting`.
 * The harness declares the intent by throwing {@link SessionLimitDeclinedError}; the execution
 * layer cancels the root turn, whose cancelled arm cascades to every descendant, so a delegating
 * parent never receives an error it could retry against a fresh budget share.
 */
export function applyBudgetAnswer(
  step: Step,
  answer: { readonly granted: boolean } | undefined,
): void {
  if (answer === undefined) return;
  if (!answer.granted) throw new SessionLimitDeclinedError();
  step.session = bumpSessionRuntimeUsageLimits(step.session);
}

/**
 * The gate before each model call. Within budget, returns `undefined`. Over budget, a session
 * that can request input parks on the continuation prompt; any other fails.
 */
export async function enforceBudget(
  step: Step,
  messages: readonly HarnessModelMessage[],
): Promise<StepResult | undefined> {
  const violation = getSessionUsageLimitViolation(step.session);
  if (violation === null) return undefined;

  const { emit } = step;
  // A zero limit is an exhausted quota inherited by a delegated task.
  // Approving would bump the runtime limit by the configured limit -- zero --
  // so fail the child and let its parent reach the resumable limit gate.
  if (
    violationWindow(violation) > 0 &&
    emit !== undefined &&
    step.config.capabilities?.requestInput === true
  ) {
    return askToContinue(step, emit, messages, violation);
  }
  return failOverBudget(step, violation);
}

/**
 * Parks the session on the continuation prompt. No model call happens: the request is
 * harness-authored, and the parked history carries the step's messages so the triggering user
 * message survives into the resumed turn.
 */
async function askToContinue(
  step: Step,
  emit: NonNullable<Step["emit"]>,
  messages: readonly HarnessModelMessage[],
  violation: SessionUsageLimitViolation,
): Promise<StepResult> {
  const request = createSessionLimitContinuationRequest({
    sessionId: step.session.sessionId,
    violation,
  });
  const position = step.position();
  const event = {
    sequence: position.sequence,
    stepIndex: position.stepIndex,
    turnId: position.turnId,
  };
  step.session = appendPendingInputBatch({
    event,
    requests: [request],
    responseMessages: [],
    session: { ...step.session, history: [...messages] },
  });
  await emit(createInputRequestedEvent({ requests: [request], ...event }));
  step.moveTo(
    await emitTurnEpilogue(emit, position, step.session.history, getSessionUsage(step.session)),
  );
  return { next: null, session: step.session };
}

function violationWindow(violation: SessionUsageLimitViolation): number {
  return violation.kind === "token-cost" ? violation.limitUsd : violation.limit;
}

function formatSessionLimitMessage(kind: SessionUsageLimitViolation["kind"]): string {
  return kind === "token-cost"
    ? "The session reached its configured model token-cost limit."
    : `The session reached its configured ${kind} token limit.`;
}

async function failOverBudget(
  step: Step,
  violation: SessionUsageLimitViolation,
): Promise<StepResult> {
  const usage = getSessionTokenUsage(step.session);
  const message = formatSessionLimitMessage(violation.kind);
  const details: JsonObject =
    violation.kind === "token-cost"
      ? {
          costUsd: usage.costUsd,
          kind: violation.kind,
          limitUsd: violation.limitUsd,
          usedCostUsd: violation.usedCostUsd,
        }
      : {
          inputTokens: usage.inputTokens,
          kind: violation.kind,
          limit: violation.limit,
          outputTokens: usage.outputTokens,
          usedTokens: violation.usedTokens,
        };

  if (step.emit) {
    await emitFailedStep(step.emit, step.position(), {
      code:
        violation.kind === "token-cost"
          ? SESSION_TOKEN_COST_LIMIT_REACHED_CODE
          : SESSION_TOKEN_LIMIT_REACHED_CODE,
      details,
      message,
      sessionId: step.session.sessionId,
      usage: getSessionUsage(step.session),
    });
  }

  return { next: { done: true, output: "" }, session: step.session };
}
