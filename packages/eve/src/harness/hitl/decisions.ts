import { openLimit } from "#harness/session-machine/view.js";
import { cleanupHitl } from "./record.js";
import { applyRecordedSettlements } from "./approval.js";
import { authorizationRequested } from "./authorization.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type {
  SessionView,
  StepCoordinates,
  TurnState,
  SuspendedStep,
} from "#harness/session-machine/view.js";
import { foldSession } from "#protocol/session-projection.js";
import type { Command, EffectCommand } from "./command.js";
import type { Transition } from "#harness/session-machine/commit.js";
import type { ModelMessage, ToolResultPart } from "ai";
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
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { FromStep, FromInbox, FromRelay, FromHost, PolicyCheck, PolicyRun } from "./input.js";
import { typedAnswers } from "./input-typed-reply.js";
import { reduce, verdictsOf } from "./reducer.js";
import { sameStep } from "#harness/session-machine/view.js";
import { openApprovalsOf } from "./approval.js";

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
