/**
 * The budget question. Over budget before a model call, a turn a person can
 * reach asks whether to continue and holds until they answer: Continue grants
 * a fresh budget window and the same model call runs, Stop cancels the turn.
 * A message that does not answer it stays in the turn's history, read once the
 * turn runs again.
 */
import { resolveTextToResponse } from "#channel/resolve-text.js";
import type { HumanInputEvent, HumanInputState, Interrupt } from "#harness/human-input/index.js";
import {
  isSessionLimitContinuationRequestId,
  SESSION_LIMIT_CONTINUE_OPTION_ID,
  SESSION_LIMIT_STOP_OPTION_ID,
} from "#harness/human-input/budget-question.js";
import {
  createInputRequestedEvent,
  createInputResolvedEvent,
  type InputResolutionOutcome,
} from "#protocol/message.js";
import type { StepInput } from "#harness/types.js";
import type { InputResponse } from "#shared/input.js";

type BudgetRequest = Extract<
  HumanInputState["requests"][string],
  { readonly kind: "session-limit" }
>;

interface Reduced {
  readonly events: readonly HumanInputEvent[];
  readonly state: HumanInputState;
}

/** Opens the budget question, or holds on it again: each violation is asked once. */
export function askBudget(
  state: HumanInputState,
  interrupt: Extract<Interrupt, { readonly type: "budget.exceeded" }>,
): Reduced {
  const { at, request } = interrupt;
  if (state.requests[request.requestId] !== undefined) return { events: [], state };
  return {
    events: [{ event: createInputRequestedEvent({ ...at, requests: [request] }), type: "publish" }],
    state: {
      ...state,
      requests: { ...state.requests, [request.requestId]: { at, kind: "session-limit", request } },
    },
  };
}

/**
 * Drops the answers to budget questions that already closed, before answers
 * to closed requests become text the model reads: read as text, a late Stop
 * would seem to stop something, and a late Continue must not grant budget.
 */
export function withoutClosedBudgetAnswers(
  input: StepInput | undefined,
  openRequestIds: ReadonlySet<string>,
): StepInput | undefined {
  if (input === undefined) return undefined;
  const keep = (response: InputResponse) =>
    openRequestIds.has(response.requestId) ||
    !isSessionLimitContinuationRequestId(response.requestId);
  const responses = input.inputResponses ?? [];
  const attributed = input.attributedInputResponses ?? [];
  const kept = responses.filter(keep);
  const keptAttributed = attributed.filter(({ response }) => keep(response));
  if (kept.length === responses.length && keptAttributed.length === attributed.length) {
    return input;
  }
  const { attributedInputResponses: _attributed, inputResponses: _responses, ...rest } = input;
  return {
    ...rest,
    ...(kept.length > 0 && { inputResponses: kept }),
    ...(keptAttributed.length > 0 && { attributedInputResponses: keptAttributed }),
  };
}

/**
 * Applies the answers to the budget question. An answer with neither option
 * is dropped, like a late one. Returns the answers to other requests as
 * `unclaimed`.
 */
export function answerBudget(
  state: HumanInputState,
  responses: readonly InputResponse[],
): Reduced & { readonly unclaimed: readonly InputResponse[] } {
  let next = state;
  const events: HumanInputEvent[] = [];
  const unclaimed: InputResponse[] = [];
  for (const response of responses) {
    const open = next.requests[response.requestId];
    if (open?.kind !== "session-limit") {
      unclaimed.push(response);
      continue;
    }
    const decided = decide(open, response);
    if (decided === undefined) continue;
    next = close(next, open);
    events.push(...decided);
  }
  return { events, state: next, unclaimed };
}

/**
 * A typed reply answers the budget question when it names one of its options.
 * Returns `undefined` when the message answers nothing and is for the model.
 */
export function answerBudgetByText(state: HumanInputState, text: string): Reduced | undefined {
  const open = openBudget(state);
  if (open === undefined) return undefined;
  const response = resolveTextToResponse(text, open.request);
  const decided = response === undefined ? undefined : decide(open, response);
  if (decided === undefined) return undefined;
  return { events: [{ type: "message.answered" }, ...decided], state: close(state, open) };
}

/** The turn was cancelled: its budget question closes unanswered. */
export function withdrawBudget(state: HumanInputState): Reduced {
  const open = openBudget(state);
  if (open === undefined) return { events: [], state };
  return { events: [resolved(open, "cancelled")], state: close(state, open) };
}

function decide(open: BudgetRequest, response: InputResponse): HumanInputEvent[] | undefined {
  switch (response.optionId) {
    case SESSION_LIMIT_CONTINUE_OPTION_ID:
      return [resolved(open, "answered", response), { type: "budget.granted" }];
    case SESSION_LIMIT_STOP_OPTION_ID:
      return [
        resolved(open, "answered", response),
        { requestId: open.request.requestId, type: "budget.declined" },
      ];
    default:
      return undefined;
  }
}

function openBudget(state: HumanInputState): BudgetRequest | undefined {
  for (const open of Object.values(state.requests)) {
    if (open.kind === "session-limit") return open;
  }
  return undefined;
}

function close(state: HumanInputState, open: BudgetRequest): HumanInputState {
  const { [open.request.requestId]: _closed, ...requests } = state.requests;
  return { ...state, requests };
}

function resolved(
  open: BudgetRequest,
  outcome: InputResolutionOutcome,
  response?: InputResponse,
): HumanInputEvent {
  const { requestId } = open.request;
  return {
    event: createInputResolvedEvent({
      ...open.at,
      resolutions: [{ kind: "session-limit", outcome, requestId, ...(response && { response }) }],
    }),
    type: "publish",
  };
}
