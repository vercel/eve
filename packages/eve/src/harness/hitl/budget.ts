import type { ModelMessage } from "ai";
import { interactionOpened, interactionSettled } from "#harness/interaction-facts.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import type { Transition } from "#harness/session-machine/commit.js";
import { fail } from "#harness/session-machine/transitions.js";
import {
  ownOpenRequestIds,
  storedProjection,
  turnPosition,
  type SessionView,
} from "#harness/session-machine/view.js";
import type { Step } from "#harness/step/context.js";
import type { HarnessStepInput, SessionStateMap, StepResult } from "#harness/types.js";
import { openRequests } from "#protocol/session-projection/reader.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { InteractionRequest } from "#protocol/session-events/families/interaction.js";
import type {
  InteractionRow,
  SessionView as SessionTables,
} from "#protocol/session-projection/tables.js";
import type { SessionUsageLimit } from "#shared/agent-definition.js";
import { APPROVE_OPTION_ID, DENY_OPTION_ID, type Answer } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import { usageSince } from "#shared/token-usage-math.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { responseLedger, responseOf, standingAnswers } from "./responses.js";

// The session usage budget. Committed usage facts are the lifetime spend; the fold starts each
// window at the committed total where the session's own last accepted Continue landed. Before each model call, a spent window asks to continue when
// someone can answer and fails the session otherwise. The prompt's answer grants a new window or
// stops the turn tree. The session core still owns what an open budget prompt means for
// scheduling: it holds messages and the turn open, and a cancel withdraws it.

/** Why an answer to the budget prompt that is neither Continue nor Stop doesn't count. */
const INVALID_BUDGET_ANSWER = "The budget prompt takes Continue or Stop.";

/** Cache reads replay history rather than spending new input. Cache writes still count. */
export const DEFAULT_SESSION_USAGE_LIMIT: SessionUsageLimit = ({ window }) =>
  window.inputTokens - window.cacheReadTokens >= 40_000_000;

export interface LimitAsk {
  readonly interactionId: string;
  readonly request: InteractionRequest;
}

export type SessionUsageLimitCheck =
  | { readonly kind: "within" }
  | { readonly kind: "ask"; readonly ask: LimitAsk }
  | {
      readonly kind: "fail";
      readonly code: string;
      readonly details: JsonObject;
      readonly message: string;
    };

export function checkSessionUsageLimit(input: {
  readonly canAsk: boolean;
  readonly limit: SessionUsageLimit;
  readonly session: { readonly sessionId: string; readonly state?: SessionStateMap };
  readonly turnSequence: number;
  readonly usage: TokenUsage;
  /** The window the last accepted budget prompt started; the stored one by default. */
  readonly window?: SessionProjection["usageWindow"];
}): SessionUsageLimitCheck {
  const total = input.usage;
  const started = input.window ?? storedProjection(input.session.state).usageWindow;
  const window = usageSince(total, started?.start);
  if (
    (window.inputTokens === 0 && window.outputTokens === 0 && !window.costUsd) ||
    !input.limit({ total: { ...total }, window: { ...window } })
  )
    return { kind: "within" };
  if (input.canAsk)
    return {
      kind: "ask",
      ask: createSessionLimitContinuationRequest({
        sessionId: input.session.sessionId,
        turnSequence: input.turnSequence,
        windowIndex: started?.index ?? 0,
      }),
    };
  return {
    kind: "fail",
    code: "SESSION_USAGE_LIMIT_REACHED",
    details: { total: toJsonUsage(total), window: toJsonUsage(window) },
    message: "The session reached its usage limit.",
  };
}

export function createSessionLimitContinuationRequest(input: {
  readonly sessionId: string;
  readonly turnSequence: number;
  readonly windowIndex: number;
}): LimitAsk {
  const { sessionId, turnSequence, windowIndex } = input;
  return {
    // Cost-only windows can advance without any token count changing.
    interactionId: `${sessionId}:${turnSequence}:limit:usage:${windowIndex}`,
    request: {
      allowFreeform: false,
      display: "confirmation",
      kind: "budget",
      options: [
        {
          description: "Start a new usage window",
          id: APPROVE_OPTION_ID,
          label: "Approve",
          style: "primary",
        },
        { description: "Stop now", id: DENY_OPTION_ID, label: "Stop", style: "danger" },
      ],
      prompt:
        "This session has hit its usage limit. This is a guardrail against defective " +
        "long-running sessions. If session activity looks fine, just approve to keep going.",
    },
  };
}

export function limitDecision(
  answer: Pick<Answer, "optionId">,
): { readonly granted: boolean } | undefined {
  if (answer.optionId === APPROVE_OPTION_ID) return { granted: true };
  if (answer.optionId === DENY_OPTION_ID) return { granted: false };
  return undefined;
}

/** The budget prompt this session asked and still waits on. */
export function openLimit(view: SessionView): InteractionRow | undefined {
  const own = ownOpenRequestIds(view);
  return openRequests(view.projection.view).find(
    (open) => open.request.kind === "budget" && own.has(open.interactionId),
  );
}

/**
 * The gate before each model call. `messages` are the step's: they park with the prompt, so the
 * input that triggered it survives into the turn that resumes.
 */
export async function enforceBudget(
  step: Step,
  messages: readonly ModelMessage[],
): Promise<StepResult | undefined> {
  const limit = checkSessionUsageLimit({
    canAsk: step.emit !== undefined && step.config.capabilities?.requestInput === true,
    limit: step.config.sessionUsageLimit ?? DEFAULT_SESSION_USAGE_LIMIT,
    session: step.session,
    turnSequence: step.position().sequence,
    usage: step.view().projection.view.usage.total,
    window: step.view().projection.usageWindow,
  });
  if (limit.kind === "within") return undefined;
  if (limit.kind === "ask") {
    step.session = { ...step.session, history: validateHarnessModelMessages([...messages]) };
    // The prompt is asked once; a gate that finds it open still waits on it.
    if (openLimit(step.view())?.interactionId !== limit.ask.interactionId)
      await step.apply(requestLimit(step.view(), limit.ask), step.session.history);
    return { session: step.session };
  }
  await step.apply(
    fail(step.view(), {
      code: limit.code,
      details: limit.details,
      message: limit.message,
      terminal: true,
    }),
  );
  return { ended: { output: "" }, session: step.session };
}

function requestLimit(view: SessionView, ask: LimitAsk): Transition {
  const { turnId } = turnPosition(view.projection);
  return {
    events: [interactionOpened({ ...ask, subject: { turnId } })],
    turn: view.turn,
  };
}

/**
 * The budget prompt settles on its standing answer: Continue grants a fresh budget, and Stop
 * declines it. Any other answer is refused, and the prompt stays open for another.
 */
export function settleLimit(view: SessionView): Transition & {
  readonly limit?: { readonly granted: boolean };
} {
  const interactionId = openLimit(view)?.interactionId;
  const tables = view.projection.view;
  const answer =
    interactionId === undefined ? undefined : standingAnswers(tables).get(interactionId);
  const response = interactionId === undefined ? undefined : responseOf(interactionId, answer);
  if (interactionId === undefined || answer === undefined || response === undefined)
    return { events: [], turn: view.turn };
  const responses = responseLedger(tables);
  const granted = limitDecision(response);
  if (granted === undefined) {
    responses.settle(answer.responseId, "refused", INVALID_BUDGET_ANSWER);
    return { events: responses.facts(), turn: view.turn };
  }
  responses.settle(answer.responseId, "applied");
  responses.closeOthers(interactionId, answer.responseId);
  return {
    events: [
      ...responses.facts(),
      interactionSettled(interactionId, granted.granted ? "accepted" : "declined", {
        cause: { responseId: answer.responseId },
        response,
      }),
    ],
    limit: granted,
    turn: view.turn,
  };
}

/**
 * A stale answer to a budget prompt is dropped rather than converted to text: a stale Stop would
 * read as prose, and a stale grant must not extend a budget. The answer also cannot resolve a
 * pending batch it never answered.
 */
export function withoutStaleBudgetAnswers(input: {
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly stepInput?: HarnessStepInput;
  readonly tables: SessionTables;
}): HarnessStepInput | undefined {
  if (input.stepInput === undefined) return undefined;
  const answers = input.stepInput.answers ?? [];
  const retained = answers.filter(
    ({ interactionId }) =>
      input.pendingRequestIds.has(interactionId) ||
      input.tables.interactions[interactionId]?.request.kind !== "budget",
  );
  if (retained.length === answers.length) return input.stepInput;
  const { answers: _answers, ...rest } = input.stepInput;
  return retained.length === 0 ? rest : { ...rest, answers: retained };
}

function toJsonUsage(usage: TokenUsage): JsonObject {
  const { costUsd, ...tokens } = usage;
  return costUsd === undefined ? tokens : { ...tokens, costUsd };
}
