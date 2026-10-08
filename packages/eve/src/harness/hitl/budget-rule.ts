import { foldSession } from "#protocol/session-projection.js";
import { openLimit, type SessionView } from "#harness/session-machine/view.js";
import type { InputRequest } from "#shared/input.js";
import type { StepCoordinates } from "#harness/session-machine/state.js";
/**
 * The budget question. Over budget before a model call, a turn a person can
 * reach asks whether to continue and waits until they answer: Continue grants
 * a fresh budget window and the same model call runs, Stop cancels the turn.
 * A message that does not answer it stays in the turn's history, read once the
 * turn runs again.
 */
import type { Command } from "#harness/hitl/command.js";
import type { Input } from "#harness/hitl/input.js";
import type { Reduced } from "#harness/hitl/record.js";
import {
  SESSION_LIMIT_CONTINUE_OPTION_ID,
  SESSION_LIMIT_STOP_OPTION_ID,
} from "#harness/hitl/budget-question.js";
import {
  createInputRequestedEvent,
  createInputResolvedEvent,
  type InputResolutionOutcome,
} from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";

type BudgetRequest = {
  readonly at: StepCoordinates;
  readonly request: InputRequest;
  readonly kind: "session-limit";
};

/** Opens the budget question, or waits on it again: each violation is asked once. */
export function askBudget(
  state: SessionView,
  input: Extract<Input, { readonly type: "budget.exceeded" }>,
): Reduced {
  const { at, request } = input;
  if (
    Object.values(state.projection.inputs).some(
      (input) => input.status !== "settled" && input.request.requestId === request.requestId,
    )
  )
    return { events: [], state };
  return {
    events: [{ event: createInputRequestedEvent({ ...at, requests: [request] }), type: "publish" }],
    state,
  };
}

/**
 * Applies the answers to the budget question, the last one winning. An
 * answer with neither option is dropped, like a late one. Returns the answers
 * to other requests as `unclaimed`.
 */
export function answerBudget(
  state: SessionView,
  responses: readonly InputResponse[],
): Reduced & { readonly unclaimed: readonly InputResponse[] } {
  let next = state;
  const events: Command[] = [];
  const unclaimed: InputResponse[] = [];
  const answers = new Map<string, InputResponse>();
  for (const response of responses) {
    if (openBudget(next)?.request.requestId === response.requestId) {
      answers.set(response.requestId, response);
    } else {
      unclaimed.push(response);
    }
  }
  for (const response of answers.values()) {
    const open = openBudget(next);
    if (open?.request.requestId !== response.requestId) continue;
    const decided = decide(open, response);
    if (decided === undefined) continue;
    next = close(next, open);
    events.push(...decided);
  }
  return { events, state: next, unclaimed };
}

/**
 * A Stop ended the turn: the cancelled turn settles from before the step that
 * read it, so the question it answered closes again, with nothing published.
 */
export function stopBudget(state: SessionView, requestId: string): Reduced {
  const open = openBudget(state);
  if (open?.request.requestId !== requestId) return { events: [], state };
  return { events: [], state: close(state, open) };
}

/** The turn was cancelled: its budget question closes unanswered. */
export function withdrawBudget(state: SessionView): Reduced {
  const open = openBudget(state);
  if (open === undefined) return { events: [], state };
  return { events: [resolved(open, "cancelled")], state: close(state, open) };
}

function decide(open: BudgetRequest, response: InputResponse): Command[] | undefined {
  switch (response.optionId) {
    case SESSION_LIMIT_CONTINUE_OPTION_ID:
      return [resolved(open, "answered", response), { type: "grantBudget" }];
    case SESSION_LIMIT_STOP_OPTION_ID:
      return [
        resolved(open, "answered", response),
        { requestId: open.request.requestId, type: "declineBudget" },
      ];
    default:
      return undefined;
  }
}

function openBudget(state: SessionView): BudgetRequest | undefined {
  const input = openLimit(state);
  return input === undefined
    ? undefined
    : { at: input, request: input.request, kind: "session-limit" };
}

function close(state: SessionView, open: BudgetRequest): SessionView {
  return {
    ...state,
    projection: foldSession(
      state.projection,
      createInputResolvedEvent({
        ...open.at,
        resolutions: [
          { kind: "session-limit", outcome: "cancelled", requestId: open.request.requestId },
        ],
      }),
    ),
  };
}

function resolved(
  open: BudgetRequest,
  outcome: InputResolutionOutcome,
  response?: InputResponse,
): Command {
  const { requestId } = open.request;
  return {
    event: createInputResolvedEvent({
      ...open.at,
      resolutions: [{ kind: "session-limit", outcome, requestId, ...(response && { response }) }],
    }),
    type: "publish",
  };
}
