import type { ModelMessage, UserContent } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import {
  answerBudget,
  answerBudgetByText,
  askBudget,
  withdrawBudget,
  withoutClosedBudgetAnswers,
} from "#harness/human-input/budget.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import {
  answerApprovals,
  cancelApprovals,
  grantedApprovalKeys,
  openApprovals,
  receiveMessage,
  settleCalls,
  type OpenApproval,
} from "./approvals.js";
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
   * runs while a request is open.
   */
  next(): Next {
    return Object.keys(this.#state.requests).length === 0 ? { run: "model" } : { held: "input" };
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

  #apply(reduced: Reduced): Transition {
    return { events: reduced.events, humanInput: new HumanInput(reduced.state) };
  }

  /** The ids of every open request, for routing an answer to this session. */
  openRequestIds(): ReadonlySet<string> {
    return new Set(Object.keys(this.#state.requests));
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
      readonly callIds: readonly string[];
      readonly challenges: readonly AuthorizationChallenge[];
      readonly requester: SessionAuthContext | null;
    }
  /** The budget ran out before a model call, and a person can grant more. */
  | {
      readonly type: "budget.exceeded";
      readonly at: RequestAt;
      readonly request: InputRequest;
    }
  /** A child session or workflow run asks a person, through this session. */
  | {
      readonly type: "relayed.requested";
      readonly at: RequestAt;
      readonly requests: readonly InputRequest[];
      readonly route: RelayRoute;
    };

/** What may arrive for the turn. */
export type Intake =
  | {
      readonly type: "answered";
      readonly responses: readonly InputResponse[];
      readonly responder: SessionAuthContext | null;
    }
  /** A message; from the person who started the turn, it steers it. */
  | {
      readonly type: "message";
      readonly text: string;
      readonly sender: SessionAuthContext | null;
    }
  | { readonly type: "cancelled" }
  | {
      readonly type: "authorization.completed";
      readonly attemptId: string;
      readonly outcome: "authorized" | "failed";
    }
  /** The runtime ran a response policy that `responder.check` asked for. */
  | {
      readonly type: "responder.checked";
      readonly candidateId: string;
      readonly verdict: "allowed" | "rejected" | "failed" | "authorization-required";
    }
  /**
   * Calls of the suspended step settled: those `calls.approved` asked for, or
   * runtime calls that ran beside open approvals. `running` names the
   * approved calls that still run as runtime work.
   */
  | {
      readonly type: "calls.settled";
      readonly results: readonly ModelMessage[];
      readonly running?: readonly string[];
    }
  | { readonly type: "time"; readonly now: number }
  /** A workflow run or child session ended; nobody can answer what it relayed. */
  | { readonly type: "run.ended"; readonly runId: string };

/**
 * What happened. Each has one meaning for the runtime, which applies it and
 * decides nothing: publish an event, append to history, run work and report
 * back through `intake`, or end the turn.
 */
export type HumanInputEvent =
  | { readonly type: "publish"; readonly event: UnstampedMessageStreamEvent }
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
  /** Run a response policy for this answer; report `responder.checked`. */
  | { readonly type: "responder.check"; readonly candidateId: string; readonly requestId: string }
  /** Deliver an answer to the child session or run that asked. */
  | {
      readonly type: "answer.forwarded";
      readonly route: RelayRoute;
      readonly response: InputResponse;
    }
  /** Grant a fresh budget window: the person chose to continue. */
  | { readonly type: "budget.granted" }
  /** The person chose to stop: the budget question is resolved; cancel the turn. */
  | { readonly type: "budget.declined"; readonly requestId: string }
  /** Tell the model something with the turn's next input. */
  | { readonly type: "note"; readonly text: string }
  | { readonly type: "turn.cancelled" }
  | { readonly type: "turn.failed"; readonly code: string; readonly message: string };

export interface Transition {
  readonly humanInput: HumanInput;
  readonly events: readonly HumanInputEvent[];
}

export type Next = { readonly run: "model" } | { readonly held: "input" };

/** Where a relayed request's answer goes. */
export interface RelayRoute {
  readonly childContinuationToken: string;
  readonly runId?: string;
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
}

type OpenRequest =
  | OpenApproval
  | {
      readonly kind: "authorization";
      readonly at: RequestAt;
      readonly callIds: readonly string[];
      readonly challenge: AuthorizationChallenge;
      readonly requester: SessionAuthContext | null;
    }
  | { readonly kind: "session-limit"; readonly at: RequestAt; readonly request: InputRequest }
  | {
      readonly kind: "relayed";
      readonly at: RequestAt;
      readonly request: InputRequest;
      readonly route: RelayRoute;
    };

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
    state.grants.length === 0
  );
}

// ---------------------------------------------------------------------------
// The rules: one reducer, (state, input) -> (state, events).
// ---------------------------------------------------------------------------

interface Reduced {
  readonly events: readonly HumanInputEvent[];
  readonly state: HumanInputState;
}

function reduce(state: HumanInputState, input: Interrupt | Intake): Reduced {
  switch (input.type) {
    case "budget.exceeded":
      return askBudget(state, input);
    case "approvals.requested":
      // Response policies decide who may answer; they come back in a later change.
      if (input.responsePolicyRequestIds.length > 0) {
        return unavailable(
          state,
          "This turn needs an approval whose tool defines an `approval.response` policy, which eve cannot ask for yet.",
        );
      }
      return openApprovals(state, input);
    case "answered": {
      const budget = answerBudget(state, input.responses);
      const approvals = answerApprovals(budget.state, budget.unclaimed);
      return { events: [...budget.events, ...approvals.events], state: approvals.state };
    }
    // A typed reply answers the budget question when it names one of its
    // options; otherwise it is for the approvals.
    case "message":
      return answerBudgetByText(state, input.text) ?? receiveMessage(state, input.text);
    case "cancelled": {
      const budget = withdrawBudget(state);
      const approvals = cancelApprovals(budget.state);
      return { events: [...budget.events, ...approvals.events], state: approvals.state };
    }
    case "calls.settled":
      return settleCalls(state, input.results, input.running);
    // Human input is being rebuilt case by case. Until a case exists, a turn
    // that needs a person fails with a clear error instead of hanging.
    case "authorization.required":
    case "relayed.requested":
      return unavailable(
        state,
        `This turn needs a person (${input.type}), which eve cannot ask for yet.`,
      );
    case "authorization.completed":
    case "responder.checked":
    case "time":
    case "run.ended":
      return { events: [], state };
    default: {
      const unhandled: never = input;
      throw new TypeError(`Unhandled human input: ${JSON.stringify(unhandled)}`);
    }
  }
}

function unavailable(state: HumanInputState, message: string): Reduced {
  return { events: [{ code: "HUMAN_INPUT_UNAVAILABLE", message, type: "turn.failed" }], state };
}
