import type { ModelMessage } from "ai";
import type { RememberedApproval, RememberRequest } from "#approval/evaluation.js";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap, HarnessStepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InteractionRequest } from "#protocol/session-events/families/interaction.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

// Execution state the session machine keeps between steps. Lifecycle facts (whether a turn is
// open, whether a request is answered, how a call ended) are the projection's; this holds only
// what execution needs to resume work. Only the machine's `apply` writes it.

const TURN_STATE_KEY = "eve.harness.turnState";

/** The coordinates of the model step a suspended step parked from. */
export interface StepCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** A call that needs a person's approval, and what they're asked. */
export interface ApprovalAsk {
  readonly remember?: RememberRequest;
  readonly interactionId: string;
  readonly call: {
    readonly callId: string;
    readonly toolName: string;
    readonly input: JsonObject;
    /** The dynamic entry's version the call was made from. */
    readonly version?: string;
  };
  readonly request: InteractionRequest;
}

/**
 * A call cleared to run: a person approved it, or nothing asked them to. One a sign-in stopped
 * waits in its step until the sign-ins it lists call back, then runs as the call that asked.
 */
export interface ApprovedCall {
  readonly call: ApprovalAsk["call"];
  /** The approval that cleared the call; absent for a call only sign-ins stopped. */
  readonly interactionId?: string;
  /** The sign-ins the call stopped on: its outcome settles them. */
  readonly signIns?: readonly AuthorizationChallenge[];
  /**
   * Who approved it, when a response policy allowed their answer. The call reads it when it
   * runs, after the answer, and the responder's record with it, has settled.
   */
  readonly responder?: SessionAuthContext;
}

/**
 * A model step whose calls can't all settle yet: some await an approval or a sign-in, others the
 * runtime.
 * Its response stays out of history until every call it made has a result there, so a call
 * never reaches the model without its result.
 */
export interface SuspendedStep {
  readonly event: StepCoordinates;
  /** The withheld response. Results join it as they arrive. */
  readonly messages: readonly ModelMessage[];
  /**
   * The approvals the response's calls asked for. How each was answered is the session's
   * interaction and response tables'; this only remembers what was asked.
   */
  readonly requests: readonly ApprovalAsk[];
  /**
   * Calls a sign-in stopped. Each stays open, without a result, until the sign-ins it lists have
   * called back, then runs as the call that asked, rather than the model deciding again.
   */
  readonly approved?: readonly ApprovedCall[];
  /** Workflow and agent calls the runtime runs for the step. */
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  /**
   * A call the response ran before it parked ended the turn: once the step commits, the turn ends
   * without another model call, whatever its other calls returned.
   */
  readonly endsTurn?: true;
  readonly responseAuthRequiredRequestIds?: readonly string[];
  /** The caller whose turn parked the step; `null` when unauthenticated. */
  readonly requester?: SessionAuthContext | null;
  /**
   * Set on a batch of calls a program waits on, naming the program's `eve__execute` call. The
   * step's messages are those calls alone, never a model response: once each has a result the
   * results resume the program, and nothing of the step reaches history.
   */
  readonly program?: {
    readonly callId: string;
    /** The program runs in the background: the batch doesn't keep the model from running. */
    readonly background?: true;
  };
}

/** How one of a program's calls came out, as the program reads it when it resumes. */
export type ProgramCallResult =
  | { readonly status: "completed"; readonly output: JsonValue }
  | {
      readonly status: "failed";
      readonly error: string;
      /** How the call settled when it didn't complete; `failed` when absent. */
      readonly outcome?: "rejected" | "interrupted" | "abandoned";
    };

/** A call of a program that didn't complete, as the program's result reports it. */
export interface ProgramUnfinishedCall {
  readonly tool: string;
  readonly outcome: string;
  /** The call's input as JSON text, cut to what the model needs to tell calls apart. */
  readonly input: string;
}

/** What an interrupted attempt of a program step published about one of the program's calls. */
export interface RecoveredProgramCall {
  readonly name: string;
  readonly started: boolean;
  readonly outcome?: string;
  readonly output?: JsonValue;
  readonly error?: string;
}

/**
 * A program an `eve__execute` call runs, from the model step that made the call until the call
 * settles. Its code and call id are saved before its first call runs, so a step that runs it
 * again runs the same program under the same id.
 */
export interface ProgramRun {
  /** The `eve__execute` call. */
  readonly callId: string;
  readonly code: string;
  /** The model step that made the call. */
  readonly event: StepCoordinates;
  /** Signs the program's continuations. Never shown to the program. */
  readonly security: { readonly maxAgeMs?: number; readonly signingKey: string };
  /** Where the program parked, with every result recorded so far. Absent until it parks. */
  readonly continuation?: string;
  /** The calls the program parked on, by the interruption each raised. */
  readonly pending: readonly { readonly interruptionId: string; readonly callId: string }[];
  /** The results of parked calls, ready for the program step that resumes it. */
  readonly resolutions: readonly {
    readonly interruptionId: string;
    readonly result: ProgramCallResult;
  }[];
  /** How many of the program's calls settled each way. */
  readonly counts: Readonly<Record<string, number>>;
  /** How many of its calls reached an agent. */
  readonly agentCalls: number;
  /** The first calls that didn't complete. */
  readonly unfinished: readonly ProgramUnfinishedCall[];
  /** What an interrupted program step published about the program's calls, by call id. */
  readonly recovered?: Readonly<Record<string, RecoveredProgramCall>>;
  /**
   * The task the program became when a new message arrived while it was unfinished. Its
   * `eve__execute` call was answered with the task's receipt, and its result is the task's.
   */
  readonly background?: { readonly taskId: string };
}

export interface TurnState {
  /**
   * Turn input that arrived before the turn could take it: behind a question a message can't
   * steer past, such as the budget prompt, or behind approved calls the model reads first.
   */
  readonly queued?: HarnessStepInput;
  readonly suspended: readonly SuspendedStep[];
  /** People's approval decisions, under the keys their requests named, for the session. */
  readonly remembered: Readonly<Record<string, RememberedApproval>>;
  /** The programs the turn's `eve__execute` calls run. Absent when it runs none. */
  readonly programs?: readonly ProgramRun[];
}

export const EMPTY_TURN_STATE: TurnState = { remembered: {}, suspended: [] };

export function readTurnState(state: SessionStateMap | undefined): TurnState {
  return (state?.[TURN_STATE_KEY] as TurnState | undefined) ?? EMPTY_TURN_STATE;
}

export function writeTurnState<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turn: TurnState,
): T {
  const state = { ...session.state };
  if (
    turn.suspended.length === 0 &&
    turn.queued === undefined &&
    (turn.programs?.length ?? 0) === 0 &&
    Object.keys(turn.remembered).length === 0
  ) {
    delete state[TURN_STATE_KEY];
  } else {
    state[TURN_STATE_KEY] = turn;
  }
  return { ...session, state: Object.keys(state).length === 0 ? undefined : state };
}
