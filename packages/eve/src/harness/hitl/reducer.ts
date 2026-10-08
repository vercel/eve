import {
  type SessionView,
  openLimit,
  type StepCoordinates,
  type TurnState,
  type SuspendedStep,
  sameStep,
} from "#harness/session-machine/view.js";
import { foldSession } from "#protocol/session-projection.js";
import { answerBudget, askBudget, stopBudget, withdrawBudget } from "#harness/hitl/budget-rule.js";
import {
  answerApprovals,
  cancelApprovals,
  isPolicyGated,
  openApprovals,
  steerPastApprovals,
  applyRecordedSettlements,
  openApprovalsOf,
} from "./approval.js";
import {
  checkedCandidate,
  completeCandidateAuthorization,
  expireCandidates,
  proposeCandidates,
  staleCandidates,
} from "./approval-candidate.js";
import { type Phase } from "./host.js";
import {
  type Input,
  type PolicyCheck,
  type PolicyRun,
  type FromStep,
  type FromInbox,
  type FromRelay,
  type FromHost,
} from "./input.js";
import {
  deliverToRelayed,
  endRelayedAuthorizations,
  relay,
  relayAuthorization,
  withdrawAsk,
  withdrawRelayed,
} from "./relay.js";
import {
  closeAuthorizations,
  completeAuthorization,
  requireAuthorizations,
  authorizationRequested,
} from "./authorization.js";
import { type Reduced } from "./state.js";
import { typedAnswers } from "./input-typed-reply.js";
import { cleanupHitl } from "./record.js";
import { type AuthorizationChallenge } from "#harness/authorization.js";
import { type Command, type EffectCommand } from "./command.js";
import { type Transition } from "#harness/session-machine/commit.js";
import { type ModelMessage, type ToolResultPart } from "ai";
import {
  cancel,
  hold,
  suspend,
  settle,
  withoutApproved,
  withResult,
  stepCallIds,
} from "#harness/session-machine/transitions.js";
import { withoutCalls, assertUniqueCallIds } from "./held-step.js";
import { type UnstampedMessageStreamEvent } from "#protocol/message.js";

// ---------------------------------------------------------------------------
// The rules: one reducer, (state, input) -> (state, events).
// ---------------------------------------------------------------------------

const STEERED_REASON = "Cancelled because a new message arrived.";
const CANCELLED_REASON = "Cancelled.";

/** A check's verdict: from the committed input, or none in a `policyChecks` dry run. */
type VerdictOf = (check: PolicyCheck) => PolicyRun | undefined;

export function verdictsOf(input: Input): VerdictOf {
  const verdicts = "verdicts" in input ? input.verdicts : undefined;
  return (check) => {
    const ran = verdicts?.[check.candidateId];
    if (ran === undefined) {
      throw new Error(
        `Human input "${input.type}" needs a verdict for candidate "${check.candidateId}": run its policyChecks first.`,
      );
    }
    return ran;
  };
}

export function reduce(
  state: SessionView,
  input: Exclude<Input, { readonly type: "actions.dispatched" | "actions.settled" }>,
  phase: Phase,
  verdictOf: VerdictOf,
): Reduced {
  switch (input.type) {
    case "policy.checked": {
      const checked = checkedCandidate(state, input.candidateId, input.verdict);
      return checked.settled === undefined
        ? checked
        : then(checked, (next) => answerApprovals(next, [checked.settled!]));
    }
    case "authorization.resumed":
      // The step installs this callback fact in its scoped tool context.
      return { events: [], state };
    case "budget.exceeded":
      return askBudget(state, input);
    case "approval.requested":
      return openApprovals(state, input);
    case "authorization.required":
      return requireAuthorizations(state, input);
    case "input.answered": {
      const budget = answerBudget(state, input.responses);
      const gated = budget.unclaimed.filter((response) =>
        isPolicyGated(budget.state, response.requestId),
      );
      const plain = budget.unclaimed.filter((response) => !gated.includes(response));
      const proposed = proposeCandidates(budget.state, { ...input, responses: gated });
      return then(
        { events: [...budget.events, ...proposed.events], state: proposed.state },
        (next) => answerApprovals(next, plain, input.responder),
        (next) => checkCandidates(next, proposed.checks, verdictOf),
      );
    }
    // A typed reply answers the budget question or approvals when it names one
    // of their options; any other message steers the turn past everything it
    // waits on.
    case "message.received": {
      const typed = typedAnswers(state, input.text, "own");
      if (typed.length === 0) return steer(state);
      const budget = answerBudget(state, typed);
      return then(
        { events: [{ type: "consumeMessage" }, ...budget.events], state: budget.state },
        (next) => answerApprovals(next, budget.unclaimed, input.sender),
      );
    }
    case "cancel.requested":
      return cancelOwn(state, phase);
    case "relayed.requested":
      return relay(state, input);
    case "relayed.authorization":
      return relayAuthorization(state, input);
    case "turn.waiting":
      return { events: [{ type: "waitTurn" }], state };
    case "budget.stopped":
      return stopBudget(state, input.requestId);
    case "delivery.received":
      return deliverToRelayed(state, input);
    case "run.ended":
      return then(
        withdrawRelayed(state, (open) => open.route.runId === input.runId),
        (next) => endRelayedAuthorizations(next, input.runId),
      );
    case "relayed.withdrawn":
      return withdrawAsk(state, input);
    // A callback for an attempt no longer open completes nothing.
    case "authorization.completed": {
      const own = completeAuthorization(state, input);
      if (own !== undefined) return own;
      const readied = completeCandidateAuthorization(state, input);
      if (readied === undefined) return { events: [], state };
      return then(readied, (next) => checkCandidates(next, readied.checks, verdictOf));
    }
    case "time":
      return expireCandidates(state, input.now);
    case "context.cleared":
      return { events: [], state: clearedState(state) };
    case "input.resumed": {
      const queued = state.turn.queued;
      const rest = { ...state, turn: { ...state.turn, queued: undefined } };
      return queued === undefined
        ? { events: [], state }
        : { events: [{ type: "resumeInput", input: queued }], state: rest };
    }
    case "cancel.replayed":
      return carryCancel(state);
    default: {
      const unhandled: never = input;
      throw new TypeError(`Unhandled human input: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The turn is cancelled. Candidates go first: their events report at their
 * approval's coordinates. The cancel stops every child and run, so nobody can
 * answer what they relayed: their requests are withdrawn where the parked host
 * can carry that out. A cancel in the turn's step closes the rest and ends the
 * turn; its relayed requests stay open until the cancelled turn settles, parked.
 */
function cancelOwn(state: SessionView, phase: Phase): Reduced {
  if (phase !== "parked") {
    const closed = closeOwn(state);
    return {
      events: [...closed.events, { closed: "own", type: "cancelTurn" }],
      state: closed.state,
    };
  }
  return then(
    staleCandidates(state, CANCELLED_REASON),
    (next) => withdrawRelayed(next),
    (next) => closeOwn(next),
  );
}

/**
 * A cancel in the turn's step already closed and reported the turn's own
 * requests; the session the turn settles from, saved before that step,
 * closes them again without reporting them. Its held step stays, for
 * the parked settle to cancel with what the step left.
 */
function carryCancel(state: SessionView): Reduced {
  const closed = closeOwn(state);
  return { events: closed.events.filter((event) => event.type !== "publish"), state: closed.state };
}

/** Closes what the turn's own calls wait on, as cancelled: its step too, with `step`. */
function closeOwn(state: SessionView): Reduced {
  return then(
    staleCandidates(state, CANCELLED_REASON),
    (next) => endRelayedAuthorizations(next),
    withdrawBudget,
    cancelApprovals,
    (next) => closeAuthorizations(next, { outcome: "declined", reason: CANCELLED_REASON }),
  );
}

/**
 * A message that answers nothing moves the turn on: its approvals resolve,
 * their candidates go stale, and its authorizations are declined. The model hears
 * which of its authorizations ended, so it asks again only if still needed.
 */
function steer(state: SessionView): Reduced {
  const approvals = then(staleCandidates(state, STEERED_REASON), steerPastApprovals);
  const authorizations = closeAuthorizations(approvals.state, {
    outcome: "declined",
    reason: STEERED_REASON,
  });
  const events = [...approvals.events, ...authorizations.events];
  if (authorizations.names.length > 0) {
    events.push({
      text: `Sign-in to ${authorizations.names.join(", ")} was cancelled because the user sent a new message instead. Ask to sign in again only if the new message still needs it.`,
      type: "addNote",
    });
  }
  return { events, state: authorizations.state };
}

/**
 * Applies each check's verdict, in order. Allowed settles its approval with
 * the candidate's decision. A dry run has no verdicts: its candidates stay
 * pending.
 */
function checkCandidates(
  state: SessionView,
  checks: readonly PolicyCheck[],
  verdictOf: VerdictOf,
): Reduced {
  let reduced: Reduced = { events: [], state };
  for (const check of checks) {
    const ran = verdictOf(check);
    if (ran === undefined) continue;
    reduced = then(reduced, (next) => {
      const checked = checkedCandidate(next, check.candidateId, ran);
      const { settled } = checked;
      return settled === undefined ? checked : then(checked, (n) => answerApprovals(n, [settled]));
    });
  }
  return reduced;
}

/** Runs rules in order, each on the state the last one left, collecting their events. */
function then(first: Reduced, ...rest: ((state: SessionView) => Reduced)[]): Reduced {
  let state = foldReported(first);
  const events = [...first.events];
  for (const rule of rest) {
    const reduced = rule(state);
    events.push(...reduced.events);
    state = foldReported(reduced);
  }
  return { events, state };
}

/**
 * What a cleared session keeps: its standing grants, and what children and
 * runs relayed through it.
 */
function clearedState(state: SessionView): SessionView {
  return {
    ...state,
    signIns: [],
    turn: {
      ...state.turn,
      suspended: [],
      queued: undefined,
      hitl: {
        relayedRoutes: state.turn.hitl?.relayedRoutes,
        relayedAuthorizations: state.turn.hitl?.relayedAuthorizations,
      },
    },
  };
}

function foldReported(reduced: Reduced): SessionView {
  return {
    ...reduced.state,
    projection: reduced.events.reduce(
      (projection, command) =>
        command.type === "publish" ? foldSession(projection, command.event) : projection,
      reduced.state.projection,
    ),
  };
}

export type BeforeStepArrival =
  | FromInbox
  | FromRelay
  | FromHost
  | Extract<FromStep, { readonly type: "budget.exceeded" }>;

interface RuleDecision {
  readonly turn: TurnState;
  readonly signIns: readonly AuthorizationChallenge[];
  readonly commands: readonly Command[];
  /** Ephemeral callback facts, installed in the scoped tool context, never persisted. */
  readonly authorizations?: readonly Extract<
    FromHost,
    { readonly type: "authorization.resumed" }
  >[];
}

/** A pure machine transition and the ordered outside actions to run after saving it. */
export interface HumanInputDecision {
  readonly transition: Transition;
  readonly effects: readonly EffectCommand[];
  /** The delivered text answered a request; queued input is a separate delivery. */
  readonly consumedMessage: boolean;
  /** A Stop/cancel belongs to the turn owner, even when this host defers settling it. */
  readonly cancelled: boolean;
  readonly authorizations?: RuleDecision["authorizations"];
}

/** Arrivals are evaluated in originating suspended-step order, then the session's own/relayed requests. */
export function beforeStep(
  view: SessionView,
  arrivals: readonly BeforeStepArrival[],
  checkPolicy?: (check: PolicyCheck) => PolicyRun | undefined,
  options?: { readonly deferCancellation?: true },
): HumanInputDecision {
  let current = view;
  const commands: Command[] = [];
  for (const candidate of Object.values(view.turn.hitl?.audit?.activeCandidates ?? {})) {
    const owner = view.turn.suspended.find((step) =>
      step.requests.some((request) => request.requestId === candidate.requestId),
    );
    if (owner === undefined) continue;
    for (const challenge of candidate.authorizations ?? []) {
      if (view.projection.authorizations[challenge.attemptId ?? challenge.name] === undefined)
        commands.push(authorizationRequested(challenge, owner.event));
    }
  }
  for (const step of view.turn.suspended) {
    const before = ruleScope(current, step);
    const reduced = applyRecordedSettlements(before);
    if (reduced.events.length === 0 && reduced.state === before) continue;
    current = mergeScope(current, before, reduced.state, step, reduced.events);
    commands.push(...reduced.events);
    current = settleReady(current, commands, step.event);
  }
  const authorizations: Extract<FromHost, { readonly type: "authorization.resumed" }>[] = [];
  for (const step of [...view.turn.suspended, undefined]) {
    for (const arrival of arrivals) {
      if (arrival.type === "authorization.resumed") {
        if (step === undefined) authorizations.push(arrival);
        continue;
      }
      // Session-wide arrivals run once, after the originating held-step lenses.
      if (
        step !== undefined &&
        (arrival.type.startsWith("relayed.") ||
          arrival.type === "delivery.received" ||
          arrival.type === "run.ended" ||
          arrival.type === "budget.exceeded" ||
          arrival.type === "turn.waiting" ||
          arrival.type === "budget.stopped")
      )
        continue;
      if (
        arrival.type === "message.received" &&
        (current.turn.hitl?.readsResults === true || openLimit(current) !== undefined) &&
        typedAnswers(ruleScope(current), arrival.text, "own").length === 0
      ) {
        if (step === undefined)
          current = {
            ...current,
            turn: {
              ...current.turn,
              queued: {
                ...current.turn.queued,
                message: arrival.text,
                messageAuth: arrival.sender,
              },
            },
          };
        continue;
      }
      if (
        current.turn.hitl?.readsResults === true &&
        arrival.type === "input.answered" &&
        openLimit(current) === undefined
      ) {
        if (step === undefined)
          current = {
            ...current,
            turn: {
              ...current.turn,
              queued: {
                ...current.turn.queued,
                attributedInputResponses: [
                  ...(current.turn.queued?.attributedInputResponses ?? []),
                  ...arrival.responses.map((response) => ({ auth: arrival.responder, response })),
                ],
              },
            },
          };
        continue;
      }
      const selected =
        step === undefined
          ? undefined
          : current.turn.suspended.find((candidate) => sameStep(candidate.event, step.event));
      if (step !== undefined && selected === undefined) continue;
      const before = ruleScope(current, selected);
      const input =
        arrival.type === "input.answered" || arrival.type === "delivery.received"
          ? {
              ...arrival,
              responses: arrival.responses.filter((response) =>
                requestIds(before).has(response.requestId),
              ),
            }
          : arrival;
      const parked =
        input.type.startsWith("relayed.") ||
        input.type === "delivery.received" ||
        input.type === "run.ended";
      const reduced = reduce(
        before,
        input,
        parked ? "parked" : "pre-step",
        checkPolicy ?? verdictsOf(input),
      );
      current = mergeScope(current, before, reduced.state, selected, reduced.events);
      commands.push(...reduced.events);
      if (
        selected !== undefined &&
        arrival.type !== "cancel.replayed" &&
        arrival.type !== "cancel.requested"
      )
        current = settleReady(current, commands, selected.event);
    }
  }
  return finishDecision(
    view,
    {
      turn: current.turn,
      signIns: current.signIns,
      commands,
      ...(authorizations.length > 0 && { authorizations }),
    },
    options?.deferCancellation,
  );
}

/** A whole model response clears the result-reading barrier even when it asks nobody. */
export interface ModelStepResponse {
  readonly at: StepCoordinates;
  readonly inputs: readonly FromStep[];
}

/** Results must identify their originating step: tool call ids can be reused across steps. */
export function afterStep(
  view: SessionView,
  response: (FromStep & { readonly at: StepCoordinates }) | ModelStepResponse,
): HumanInputDecision {
  let current =
    "inputs" in response || response.type !== "actions.settled"
      ? { ...view, turn: { ...view.turn, hitl: cleanupHitl(view.turn.hitl) } }
      : view;
  const commands: Command[] = [];
  const inputs = "inputs" in response ? response.inputs : [response];
  for (const input of inputs) {
    if ("at" in input && !sameStep(input.at, response.at))
      throw new TypeError("A model response cannot contain another step's requests.");
    let selected = current.turn.suspended.find((step) => sameStep(step.event, response.at));
    if (input.type === "actions.dispatched") {
      const tasks = [...(selected?.tasks ?? []), ...input.tasks];
      assertUniqueCallIds(tasks);
      const step = {
        ...(selected ?? { event: response.at, messages: input.messages, requests: [] }),
        tasks,
        approvers: selected?.approvers,
      };
      current = {
        ...current,
        turn:
          selected === undefined
            ? suspend(current.turn, step)
            : {
                ...current.turn,
                suspended: current.turn.suspended.map((candidate) =>
                  candidate === selected ? step : candidate,
                ),
              },
      };
      continue;
    }
    if (input.type === "actions.settled") {
      if (selected === undefined) {
        commands.push(
          ...input.results.map((message): Command => ({ type: "appendHistory", message })),
        );
      } else {
        const stopped = new Set(input.authorizations?.callIds ?? []);
        const parts = input.results.flatMap((message) =>
          message.role === "tool"
            ? message.content.filter((part): part is ToolResultPart => part.type === "tool-result")
            : [],
        );
        const finished = new Set([
          ...stopped,
          ...(input.running ?? []).map((task) => task.callId),
          ...parts.map((part) => part.toolCallId),
          ...(input.approved === undefined
            ? []
            : (input.approved.callIds ??
              selected.approved?.map((request) => request.action.callId) ??
              [])),
        ]);
        const responseMessages = [
          ...selected.messages,
          ...input.results.filter((message) => message.role !== "tool"),
        ];
        const calls = stepCallIds({ messages: responseMessages });
        const messages = parts
          .filter((part) => !calls.has(part.toolCallId))
          .reduce<ModelMessage[]>((messages, part) => withResult(messages, part), responseMessages);
        const step = withoutApproved(
          {
            ...selected,
            messages: withoutCalls(messages, stopped),
            tasks: [...selected.tasks, ...(input.running ?? [])],
            approvers: { ...selected.approvers, ...input.runningApprovers },
            ...(input.approved?.following !== undefined && { following: input.approved.following }),
          },
          finished,
        );
        assertUniqueCallIds(step.tasks);
        current = {
          ...current,
          turn: {
            ...current.turn,
            suspended: current.turn.suspended.map((candidate) =>
              candidate === selected ? step : candidate,
            ),
          },
        };
        current = settleReady(
          current,
          commands,
          response.at,
          parts.filter((part) => calls.has(part.toolCallId)),
        );
      }
      if (input.authorizations !== undefined) {
        const before = ruleScope(current);
        const reduced = reduce(
          before,
          {
            type: "authorization.required",
            at: response.at,
            ...input.authorizations,
            messages: [],
            requester: null,
          },
          "post-step",
          verdictsOf(input),
        );
        current = mergeScope(current, before, reduced.state, undefined, reduced.events);
        commands.push(...reduced.events);
      }
      continue;
    }
    if (input.type === "approval.requested" && selected === undefined) {
      current = {
        ...current,
        turn: suspend(current.turn, {
          event: response.at,
          messages: input.messages,
          requests: [],
          tasks: [],
        }),
      };
      selected = current.turn.suspended.at(-1);
    }
    if (input.type === "budget.exceeded") selected = undefined;
    const before = ruleScope(current, selected);
    const reduced = reduce(
      before,
      input,
      input.type === "budget.exceeded" ? "pre-step" : "post-step",
      verdictsOf(input),
    );
    current = mergeScope(current, before, reduced.state, selected, reduced.events);
    commands.push(...reduced.events);
    if (selected !== undefined) current = settleReady(current, commands, response.at);
  }
  return finishDecision(view, { turn: current.turn, signIns: current.signIns, commands });
}

/** Rules operate on native views scoped to one originating step or session-owned inputs. */
function ruleScope(view: SessionView, step?: SuspendedStep): SessionView {
  const requests = new Set(step?.requests.map((request) => request.requestId) ?? []);
  const activeCandidates = Object.fromEntries(
    Object.entries(view.turn.hitl?.audit?.activeCandidates ?? {}).filter(([, candidate]) =>
      requests.has(candidate.requestId),
    ),
  );
  const signIns = view.signIns.filter((challenge) => {
    if (challenge.candidateId !== undefined) return challenge.candidateId in activeCandidates;
    const authorization = view.projection.authorizations[challenge.attemptId ?? challenge.name];
    return step === undefined
      ? authorization === undefined ||
          !view.turn.suspended.some((step) => sameStep(step.event, authorization))
      : authorization !== undefined && sameStep(step.event, authorization);
  });
  return {
    ...view,
    signIns,
    turn: {
      ...view.turn,
      suspended: step === undefined ? [] : [step],
      hitl: {
        ...view.turn.hitl,
        ...(view.turn.hitl?.audit !== undefined && {
          audit: {
            ...view.turn.hitl.audit,
            activeCandidates,
          },
        }),
      },
    },
    projection: {
      ...view.projection,
      inputs: Object.fromEntries(
        Object.entries(view.projection.inputs).filter(([, input]) =>
          step === undefined
            ? !view.turn.suspended.some((step) =>
                step.requests.some((request) => request.requestId === input.request.requestId),
              )
            : requests.has(input.request.requestId),
        ),
      ),
    },
  };
}

function requestIds(view: SessionView): Set<string> {
  return new Set([
    ...openApprovalsOf(view).map((open) => open.request.requestId),
    ...Object.values(view.projection.inputs)
      .filter((input) => input.status !== "settled")
      .map((input) => input.request.requestId),
  ]);
}

function mergeScope(
  view: SessionView,
  before: SessionView,
  next: SessionView,
  step: SuspendedStep | undefined,
  commands: readonly Command[],
): SessionView {
  const activeCandidates = { ...view.turn.hitl?.audit?.activeCandidates };
  for (const id of Object.keys(before.turn.hitl?.audit?.activeCandidates ?? {}))
    delete activeCandidates[id];
  Object.assign(activeCandidates, next.turn.hitl?.audit?.activeCandidates);
  const retiredSignIns = new Set(
    before.signIns.map((challenge) => challenge.attemptId ?? challenge.name),
  );
  const turn = {
    ...next.turn,
    suspended:
      step === undefined
        ? view.turn.suspended
        : view.turn.suspended.flatMap((candidate) =>
            sameStep(candidate.event, step.event) ? next.turn.suspended : [candidate],
          ),
    hitl: {
      ...next.turn.hitl,
      ...(next.turn.hitl?.audit !== undefined && {
        audit: { ...next.turn.hitl.audit, activeCandidates },
      }),
      ...(step !== undefined && {
        relayedRoutes: view.turn.hitl?.relayedRoutes,
        relayedAuthorizations: view.turn.hitl?.relayedAuthorizations,
      }),
    },
  };
  const projection = {
    ...view.projection,
    inputs: { ...view.projection.inputs, ...next.projection.inputs },
  };
  return {
    ...view,
    turn,
    signIns: [
      ...view.signIns.filter(
        (challenge) => !retiredSignIns.has(challenge.attemptId ?? challenge.name),
      ),
      ...next.signIns,
    ],
    projection: commands.reduce(
      (projection, command) =>
        command.type === "publish" ? foldSession(projection, command.event) : projection,
      projection,
    ),
  };
}

/** Settle one originating step without inspecting or committing a sibling's transcript. */
function settleReady(
  view: SessionView,
  commands: Command[],
  at: StepCoordinates,
  parts: readonly ToolResultPart[] = [],
): SessionView {
  const step = view.turn.suspended.find((step) => sameStep(step.event, at));
  if (step === undefined || ((step.approved?.length ?? 0) > 0 && stepCallIds(step).size === 0))
    return view;
  const next = settle(
    { ...view, turn: { ...view.turn, suspended: [step] } },
    { results: parts.map((part) => ({ part })) },
    at,
  );
  commands.push(...next.commit.map((message): Command => ({ type: "appendHistory", message })));
  const suspended = view.turn.suspended.flatMap((candidate) =>
    candidate === step ? next.turn.suspended : [candidate],
  );
  return {
    ...view,
    turn: {
      ...view.turn,
      suspended,
      ...(next.turn.suspended.length === 0 &&
        step.following !== undefined && { queued: step.following }),
    },
  };
}

/** Pure dry run across the same originating-step lenses as the committed decision. */
export function policyChecksBeforeStep(
  view: SessionView,
  arrivals: readonly BeforeStepArrival[],
): readonly PolicyCheck[] {
  const checks: PolicyCheck[] = [];
  beforeStep(view, arrivals, (check) => {
    checks.push(check);
    return undefined;
  });
  return checks;
}

/** Assemble the boundary transition before returning it; hosts never translate rule output. */
function finishDecision(
  view: SessionView,
  decision: RuleDecision,
  deferCancellation?: true,
): HumanInputDecision {
  let turn = decision.turn;
  let projection = view.projection;
  let signIns = decision.signIns;
  let grantBudget: true | undefined;
  let cancelled = false;
  const events: UnstampedMessageStreamEvent[] = [];
  const commit: ModelMessage[] = [];
  const effects: EffectCommand[] = [];
  const decided = decidedCallIds(view);
  const appendEvents = (next: readonly UnstampedMessageStreamEvent[]) => {
    for (const event of next) {
      events.push(event);
      projection = foldSession(projection, event);
    }
  };
  const compose = (next: Transition) => {
    turn = next.turn;
    if (next.signIns !== undefined) signIns = next.signIns;
    commit.push(...(next.commit ?? []));
    appendEvents(next.events);
  };
  for (const command of decision.commands) {
    switch (command.type) {
      // Relayed events already contain their source coordinates, exactly as machine.relay keeps them.
      case "publish":
        appendEvents([command.event]);
        break;
      case "appendHistory":
        commit.push(command.message);
        // Only a person's decision holds later arrivals: runtime results join as on main.
        if (hasResultFor(command.message, decided))
          turn = { ...turn, hitl: { ...turn.hitl, readsResults: true } };
        break;
      case "resumeInput":
        turn = { ...turn, queued: command.input };
        break;
      case "consumeMessage":
        // The delivered message is consumed by intake; queued input is a different delivery.
        break;
      case "addNote":
        turn = {
          ...turn,
          queued: { ...turn.queued, context: [...(turn.queued?.context ?? []), command.text] },
        };
        break;
      case "grantBudget":
        grantBudget = true;
        break;
      case "waitTurn":
        compose(hold({ ...view, projection, turn, signIns }, { on: "input" }));
        break;
      case "cancelTurn":
      case "declineBudget":
        if (deferCancellation === true && command.type === "cancelTurn") break;
        // A step can already have cancelled the turn before its owner settles it. Its
        // session.waiting checkpoint prunes ended turns, so do not infer an open turn
        // merely from the absence of an explicit cancelled turn in the projection.
        if (
          !cancelled &&
          (projection.activeTurnId !== undefined ||
            view.turn.suspended.length > 0 ||
            openLimit(view) !== undefined ||
            signIns.length > 0 ||
            view.relayedRequestIds.size > 0 ||
            Object.values(projection.inputs).some((input) => input.status !== "settled"))
        ) {
          // Every lens already decided its closures. Do not let the machine cancel invent
          // duplicate withdrawals for another lens whose resolution is later in this batch.
          const closedProjection = decision.commands.reduce(
            (current, pending) =>
              pending.type === "publish" &&
              (pending.event.type === "input.resolved" ||
                pending.event.type === "authorization.completed")
                ? foldSession(current, pending.event)
                : current,
            projection,
          );
          compose(cancel({ ...view, projection: closedProjection, turn, signIns }));
          cancelled = true;
        }
        turn = { ...turn, queued: undefined, hitl: cleanupHitl(turn.hitl) };
        break;
      case "forwardAnswer":
      case "withdrawQuestion":
      case "resumeAuthorization":
        effects.push(command);
        break;
      default:
        command satisfies never;
    }
  }
  return {
    consumedMessage: decision.commands.some((command) => command.type === "consumeMessage"),
    cancelled: decision.commands.some(
      (command) => command.type === "cancelTurn" || command.type === "declineBudget",
    ),
    ...(decision.authorizations !== undefined && { authorizations: decision.authorizations }),
    transition: {
      turn,
      events,
      ...(commit.length > 0 && { commit }),
      signIns,
      ...(grantBudget === true && { grantBudget }),
    },
    effects,
  };
}

/** Calls a person approved or was asked about, whose results the model reads before more input. */
function decidedCallIds(view: SessionView): ReadonlySet<string> {
  return new Set(
    view.turn.suspended.flatMap((step) =>
      [...step.requests, ...(step.approved ?? [])].flatMap((request) =>
        request.action.kind === "tool-call" ? [request.action.callId] : [],
      ),
    ),
  );
}

function hasResultFor(message: ModelMessage, callIds: ReadonlySet<string>): boolean {
  return (
    message.role === "tool" &&
    message.content.some((part) => part.type === "tool-result" && callIds.has(part.toolCallId))
  );
}
