import type { ModelMessage, UserContent } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { AuthorizationChallenge, AuthorizationResult } from "#harness/authorization.js";
import {
  answerBudget,
  answerBudgetByText,
  askBudget,
  withdrawBudget,
  withoutClosedBudgetAnswers,
} from "#harness/human-input/budget.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import {
  answerApprovals,
  answerApprovalsByText,
  cancelApprovals,
  grantedApprovalKeys,
  isPolicyGated,
  openApprovals,
  settleCalls,
  steerPastApprovals,
  type OpenApproval,
} from "./approvals.js";
import {
  checkedCandidate,
  expireCandidates,
  proposeCandidates,
  signedInCandidate,
  staleCandidates,
  type ApprovalAudit,
  type CandidateDecision,
} from "./candidates.js";
import {
  awaitedSignIns,
  closeSignIns,
  completeSignIn,
  requireSignIns,
  type OpenSignIn,
} from "./sign-ins.js";
import {
  deliverToRelayed,
  isOpenRelayed,
  relay,
  relayedRequestIds,
  withdrawAsk,
  withdrawRelayed,
  type OpenRelayed,
} from "./relayed.js";
import { staleAnswersAsText } from "./stale-answers.js";
import type { SuspendedStep } from "./suspended-step.js";
import { arrivalsOf } from "./arrivals.js";

export { approvalsRequested, withoutApprovalParts } from "./approvals.js";
export { createSessionLimitContinuationRequest } from "./budget-question.js";

/**
 * Everything a turn waits on from a person: tool approvals, sign-ins, the
 * budget question, and requests relayed from child sessions and workflow runs.
 *
 * This is the only module that knows how human input works. The rest of eve
 * reports what happened (`interrupt`, `intake`), applies the events that come
 * back, and asks what to do next (`next`). It never reads or changes the state
 * itself, which lives under one session key that only this module touches.
 */
export class HumanInput {
  readonly #state: HumanInputState;

  private constructor(state: HumanInputState) {
    this.#state = state;
  }

  /** Reads the session's human input. */
  static read(sessionState: SessionStateMap | undefined): HumanInput {
    return new HumanInput(parseState(sessionState?.[STATE_KEY]));
  }

  /** Writes it back, removing the key when nothing is open. */
  write(sessionState: SessionStateMap | undefined): SessionStateMap | undefined {
    const next: Record<string, unknown> = { ...sessionState };
    if (isEmpty(this.#state)) delete next[STATE_KEY];
    else next[STATE_KEY] = this.#state;
    return Object.keys(next).length > 0 ? next : undefined;
  }

  /** The turn needs a person: a model step's calls, the budget, or a child asked. */
  interrupt(interrupt: Interrupt): Transition {
    return this.#apply(reduce(this.#state, interrupt));
  }

  /** Something arrived for the turn: an answer, a message, a cancel, a callback. */
  intake(intake: Intake): Transition {
    return this.#apply(reduce(this.#state, intake));
  }

  /**
   * What the turn does now: run its next model step, or wait. The model never
   * runs while a request of its own is open, sign-ins included; a relayed
   * request waits on the call that asked, not on the model.
   */
  next(): Next {
    return Object.values(this.#state.requests).some((open) => !isOpenRelayed(open))
      ? { held: "input" }
      : { run: "model" };
  }

  /**
   * The input a step runs with, once answers to closed budget questions are
   * dropped and answers to other requests that are no longer open become text
   * the model reads. `displayMessage` is that input's message as the person
   * sent it, for `message.received`.
   */
  acceptInput(input: StepInput | undefined): {
    readonly input: StepInput | undefined;
    readonly displayMessage?: string | UserContent;
  } {
    const open = this.openRequestIds();
    return staleAnswersAsText(withoutClosedBudgetAnswers(input, open), open);
  }

  /** What arrived for the turn's step, as the intakes to hand to `intake`, in order. */
  arrivals(input: Omit<Parameters<typeof arrivalsOf>[0], "held">): readonly Intake[] {
    return arrivalsOf({ ...input, held: "held" in this.next() });
  }

  /**
   * The suspended step's messages: the response of a step whose calls wait,
   * held out of history until each has a result. Tools that run for it read
   * them after history.
   */
  suspendedMessages(): readonly ModelMessage[] {
    return this.#state.suspended?.messages ?? [];
  }

  /** The approval keys `once()` approvals granted, which approval policies read. */
  grantedApprovalKeys(): ReadonlySet<string> {
    return grantedApprovalKeys(this.#state);
  }

  /** The sign-in attempts whose callbacks the turn waits for. */
  awaitedSignIns(): readonly string[] {
    return awaitedSignIns(this.#state);
  }

  #apply(reduced: Reduced): Transition {
    return { events: reduced.events, humanInput: new HumanInput(reduced.state) };
  }

  /**
   * The ids of the open requests of this session's own that an answer can
   * resolve, for routing an answer to its turn. Sign-ins are closed by their
   * callbacks instead, and relayed requests belong to whoever asked.
   */
  openRequestIds(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.#state.requests).flatMap(([requestId, open]) =>
        open.kind === "authorization" || isOpenRelayed(open) ? [] : [requestId],
      ),
    );
  }

  /** The ids of the open relayed requests, whose answers a delivery may carry to who asked. */
  relayedRequestIds(): ReadonlySet<string> {
    return relayedRequestIds(this.#state);
  }
}

/** The coordinates of the stream position a request was asked at. */
export interface RequestAt {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** What may be asked of the turn. */
export type Interrupt =
  /** A model step made calls whose approval policy asks a person. */
  | {
      readonly type: "approvals.requested";
      readonly at: RequestAt;
      /**
       * The step's response, which waits out of history until every call it
       * made has a result. Empty when the coordination batch holds it, because
       * the step also made runtime calls.
       */
      readonly messages: readonly ModelMessage[];
      readonly requests: readonly InputRequest[];
      readonly requester: SessionAuthContext | null;
      /** Each request's approval key (the tool's `approvalKey`), when its tool has one. */
      readonly approvalKeys: Readonly<Record<string, string>>;
      /** Requests whose tool decides who may answer (`approval.response`). */
      readonly responsePolicyRequestIds: readonly string[];
    }
  /** A tool call needs a sign-in before it can run. */
  | {
      readonly type: "authorization.required";
      readonly at: RequestAt;
      /** The calls that asked; the model calls them again once signed in. */
      readonly callIds: readonly string[];
      /**
       * The step's response. It joins history without the calls that asked,
       * so history never holds a call that waits on a person. Empty when the
       * step is held elsewhere, as for approved calls that asked.
       */
      readonly messages: readonly ModelMessage[];
      readonly challenges: readonly AuthorizationChallenge[];
      readonly requester: SessionAuthContext | null;
    }
  /** The budget ran out before a model call, and a person can grant more. */
  | {
      readonly type: "budget.exceeded";
      readonly at: RequestAt;
      readonly request: InputRequest;
    }
  /**
   * A child session, remote agent, or workflow run asks a person, through this
   * session. `at` is the child batch's coordinates.
   */
  | {
      readonly type: "relayed.requested";
      readonly at: RequestAt;
      readonly requests: readonly InputRequest[];
      readonly route: RelayRoute;
      /** The task whose run asked, so readers attach the batch to it. */
      readonly taskId?: string;
    };

/** What may arrive for the turn. */
export type Intake =
  | {
      readonly type: "answered";
      readonly responses: readonly InputResponse[];
      readonly responder: SessionAuthContext | null;
      /** When the answers arrived, which starts a candidate's time to live. */
      readonly now: number;
    }
  /** A message; from the person who started the turn, it steers it. */
  | {
      readonly type: "message";
      readonly text: string;
      readonly sender: SessionAuthContext | null;
    }
  | { readonly type: "cancelled" }
  /** A sign-in's callback arrived; `failed` when it couldn't be read. */
  | {
      readonly type: "authorization.completed";
      readonly attemptId: string;
      readonly callback?: AuthorizationCallback;
      readonly connectionName: string;
      readonly outcome: "authorized" | "failed";
    }
  /** The runtime ran a response policy that `responder.check` asked for. */
  | {
      readonly type: "responder.checked";
      readonly candidateId: string;
      readonly ran: PolicyRun;
    }
  /**
   * Calls of the suspended step settled: those `calls.approved` asked for, or
   * runtime calls that ran beside open approvals. `running` names the
   * approved calls that still run as runtime work; `stopped` names the calls
   * that asked for a sign-in, which leave the step with their results.
   */
  | {
      readonly type: "calls.settled";
      readonly results: readonly ModelMessage[];
      readonly running?: readonly string[];
      readonly stopped?: readonly string[];
    }
  | { readonly type: "time"; readonly now: number }
  /** A workflow run or child session ended; nobody can answer what it relayed. */
  | { readonly type: "run.ended"; readonly runId: string }
  /**
   * A delivery reached the session outside its turn's model steps: while the
   * turn waits on the calls that asked, or between turns. Only relayed
   * requests take from it; the runtime keeps the rest for the turn.
   */
  | {
      readonly type: "delivered";
      readonly responses: readonly InputResponse[];
      /** Its message as text, and whether a delegating caller sent it rather than a person. */
      readonly message?: { readonly text: string; readonly delegated: boolean };
    }
  /** A workflow run asks to withdraw its `ctx.ask()` question `requestId`. */
  | {
      readonly type: "withdraw.requested";
      readonly control: string;
      readonly requestId: string;
      readonly runId: string;
    };

/**
 * What happened. Each has one meaning for the runtime, which applies it and
 * decides nothing: publish an event, append to history, run work and report
 * back through `intake`, or end the turn.
 */
export type HumanInputEvent =
  | {
      readonly type: "publish";
      readonly event: UnstampedMessageStreamEvent;
      /** It belongs to an exchange this session relays for a child or run: publish it as relayed. */
      readonly relayed?: true;
    }
  | { readonly type: "history.appended"; readonly message: ModelMessage }
  /**
   * Run these approved calls with the tools of the step that asked, at its
   * coordinates; report `calls.settled` with their results.
   */
  | {
      readonly type: "calls.approved";
      readonly at: RequestAt;
      readonly requests: readonly InputRequest[];
    }
  /**
   * The step's remaining calls run as runtime work: park on them with these
   * messages, the step's response, which joins history with their results.
   */
  | {
      readonly type: "calls.dispatched";
      readonly at: RequestAt;
      readonly messages: readonly ModelMessage[];
    }
  /** The message answered open requests, so the turn doesn't read it as input. */
  | { readonly type: "message.answered" }
  /**
   * Run the response policy of `request`'s tool, with the tools of the step
   * that asked, for this responder's decision; report `responder.checked`.
   */
  | {
      readonly type: "responder.check";
      readonly at: RequestAt;
      readonly candidateId: string;
      readonly decision: CandidateDecision;
      readonly request: InputRequest;
      readonly requester: SessionAuthContext | null;
      readonly responder: SessionAuthContext;
    }
  /**
   * A sign-in completed: hand its callback to the tool call or policy that
   * asked, and run as `requester` when one is given.
   */
  | {
      readonly type: "sign-in.completed";
      readonly result: AuthorizationResult & { readonly name: string };
      readonly requester: SessionAuthContext | null;
    }
  /** Deliver these answers to the child session, remote agent, or run that asked. */
  | {
      readonly type: "answer.forwarded";
      readonly route: RelayRoute;
      readonly responses: readonly InputResponse[];
    }
  /** Tell a run, on its control hook, that its `ctx.ask()` question is withdrawn. */
  | { readonly type: "question.withdrawn"; readonly control: string; readonly requestId: string }
  /** The turn waits on a person while the call that asked keeps running: publish `turn.waiting`. */
  | { readonly type: "turn.held" }
  /** Grant a fresh budget window: the person chose to continue. */
  | { readonly type: "budget.granted" }
  /** The person chose to stop: the budget question is resolved; cancel the turn. */
  | { readonly type: "budget.declined"; readonly requestId: string }
  /** Tell the model something with the turn's next input. */
  | { readonly type: "note"; readonly text: string }
  | { readonly type: "turn.cancelled" };

export interface Transition {
  readonly humanInput: HumanInput;
  readonly events: readonly HumanInputEvent[];
}

export type Next = { readonly run: "model" } | { readonly held: "input" };

/** What running a response policy did, before human input reads it as a verdict. */
export type PolicyRun =
  /** The tool no longer defines a response policy. */
  | { readonly kind: "missing" }
  | {
      readonly kind: "returned";
      readonly value: { readonly status: string; readonly reason?: string };
    }
  /** It threw or timed out; `challenges` when it threw for the responder to sign in. */
  | { readonly kind: "threw"; readonly challenges?: readonly AuthorizationChallenge[] };

/** Where a relayed request's answer goes. */
export interface RelayRoute {
  /** The child's continuation token, which names its session inbox unless `childSessionInbox` does. */
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /** A remote agent's session, answered over its own protocol. */
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
  /** Where in the child the batch came from; its fresh batch from one source replaces the last. */
  readonly inputSource?: string;
  /** The workflow run that relayed it: nobody can answer it once that run ends. */
  readonly runId?: string;
  /** The run's control hook, for its own `ctx.ask()` question. */
  readonly control?: string;
}

// ---------------------------------------------------------------------------
// State: one session key, read and written only here.
// ---------------------------------------------------------------------------

const STATE_KEY = "eve.harness.humanInput";

/** Exported only for the rules files beside this one. */
export interface HumanInputState {
  /** Every open request, by `requestId`. */
  readonly requests: Readonly<Record<string, OpenRequest>>;
  /** Input that arrived before it could run: a partial answer, or a message behind one. */
  readonly queued?: StepInput;
  /** Approval keys a `once()` approval granted for the rest of the session. */
  readonly grants: readonly string[];
  /** The model step whose calls wait, held out of history. */
  readonly suspended?: SuspendedStep;
  /** Every response-policy candidate and settlement of the session. */
  readonly audit?: ApprovalAudit;
}

type OpenRequest =
  | OpenApproval
  | OpenSignIn
  | { readonly kind: "session-limit"; readonly at: RequestAt; readonly request: InputRequest }
  | OpenRelayed;

const EMPTY: HumanInputState = { grants: [], requests: {} };

function parseState(value: unknown): HumanInputState {
  if (typeof value !== "object" || value === null) return EMPTY;
  const requests: unknown = Reflect.get(value, "requests");
  const grants: unknown = Reflect.get(value, "grants");
  if (typeof requests !== "object" || requests === null || !Array.isArray(grants)) return EMPTY;
  return value as HumanInputState;
}

function isEmpty(state: HumanInputState): boolean {
  return (
    Object.keys(state.requests).length === 0 &&
    state.queued === undefined &&
    state.suspended === undefined &&
    state.grants.length === 0 &&
    state.audit === undefined
  );
}

// ---------------------------------------------------------------------------
// The rules: one reducer, (state, input) -> (state, events).
// ---------------------------------------------------------------------------

interface Reduced {
  readonly events: readonly HumanInputEvent[];
  readonly state: HumanInputState;
}

const STEERED_REASON = "Cancelled because a new message arrived.";
const CANCELLED_REASON = "Cancelled.";

function reduce(state: HumanInputState, input: Interrupt | Intake): Reduced {
  switch (input.type) {
    case "budget.exceeded":
      return askBudget(state, input);
    case "approvals.requested":
      return openApprovals(state, input);
    case "authorization.required":
      return requireSignIns(state, input);
    case "answered": {
      const budget = answerBudget(state, input.responses);
      const gated = budget.unclaimed.filter((response) =>
        isPolicyGated(budget.state, response.requestId),
      );
      const plain = budget.unclaimed.filter((response) => !gated.includes(response));
      return then(
        budget,
        (next) => proposeCandidates(next, { ...input, responses: gated }),
        (next) => answerApprovals(next, plain),
      );
    }
    // A typed reply answers the budget question or approvals when it names one
    // of their options; any other message steers the turn past everything it
    // waits on.
    case "message":
      return (
        answerBudgetByText(state, input.text) ??
        answerApprovalsByText(state, input.text) ??
        steer(state)
      );
    case "cancelled":
      // Candidates go first: their events report at their approval's coordinates.
      // The cancel stops every child and run, so nobody can answer what they relayed.
      return then(
        staleCandidates(state, CANCELLED_REASON),
        (next) => withdrawRelayed(next),
        withdrawBudget,
        cancelApprovals,
        (next) => closeSignIns(next, { outcome: "declined", reason: CANCELLED_REASON }),
      );
    case "relayed.requested":
      return relay(state, input);
    case "delivered":
      return deliverToRelayed(state, input);
    case "run.ended":
      return withdrawRelayed(state, (open) => open.route.runId === input.runId);
    case "withdraw.requested":
      return withdrawAsk(state, input);
    case "calls.settled":
      return settleCalls(state, input.results, input.running, input.stopped);
    case "authorization.completed": {
      const completed = completeSignIn(state, input);
      if (completed === undefined) return { events: [], state };
      const { candidateId } = completed.challenge;
      if (candidateId === undefined) return completed;
      return then(completed, (next) =>
        signedInCandidate(next, { candidateId, outcome: input.outcome }),
      );
    }
    case "responder.checked": {
      const checked = checkedCandidate(state, input);
      const { settled } = checked;
      return settled === undefined
        ? checked
        : then(checked, (next) => answerApprovals(next, [settled]));
    }
    case "time":
      return expireCandidates(state, input.now);
    default: {
      const unhandled: never = input;
      throw new TypeError(`Unhandled human input: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * A message that answers nothing moves the turn on: its approvals resolve,
 * their candidates go stale, and its sign-ins are declined. The model hears
 * which of its sign-ins ended, so it asks again only if still needed.
 */
function steer(state: HumanInputState): Reduced {
  const approvals = then(staleCandidates(state, STEERED_REASON), steerPastApprovals);
  const signIns = closeSignIns(approvals.state, { outcome: "declined", reason: STEERED_REASON });
  const events = [...approvals.events, ...signIns.events];
  if (signIns.names.length > 0) {
    events.push({
      text: `Sign-in to ${signIns.names.join(", ")} was cancelled because the user sent a new message instead. Ask to sign in again only if the new message still needs it.`,
      type: "note",
    });
  }
  return { events, state: signIns.state };
}

/** Runs rules in order, each on the state the last one left, collecting their events. */
function then(first: Reduced, ...rest: ((state: HumanInputState) => Reduced)[]): Reduced {
  let state = first.state;
  const events = [...first.events];
  for (const rule of rest) {
    const reduced = rule(state);
    events.push(...reduced.events);
    state = reduced.state;
  }
  return { events, state };
}
