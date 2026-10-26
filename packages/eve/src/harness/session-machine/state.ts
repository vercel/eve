import type { ModelMessage } from "ai";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";

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

/**
 * A call that runs on the turn's next model call, whatever asked for it: a person approved it, or
 * the sign-ins it waited on called back.
 */
export type ApprovedCall = Pick<InputRequest, "action" | "requestId"> & {
  /** The sign-ins the call stopped on: its outcome settles them. */
  readonly signIns?: readonly AuthorizationChallenge[];
};

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
  /** Approvals the step still waits on. */
  readonly requests: readonly InputRequest[];
  /**
   * Calls a person approved that haven't run. They run when the turn next calls the model, after
   * its step starts and its budget allows it, as calls the model makes do. A call a sign-in
   * stopped is one of them, once the sign-ins it lists have called back, so the call that asked
   * runs, rather than the model deciding again.
   */
  readonly approved?: readonly ApprovedCall[];
  /** Workflow and agent calls the runtime runs for the step. */
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  /** The caller whose turn parked the step; `null` when unauthenticated. */
  readonly requester?: SessionAuthContext | null;
}

export interface TurnState {
  /** Input that arrived before it could run: a partial answer, or input behind a policy pass. */
  readonly queued?: StepInput;
  readonly suspended: readonly SuspendedStep[];
  /** Approval keys a `once()` approval granted for the rest of the session. */
  readonly grants: readonly string[];
}

export const EMPTY_TURN_STATE: TurnState = { grants: [], suspended: [] };

export function readTurnState(state: SessionStateMap | undefined): TurnState {
  return (state?.[TURN_STATE_KEY] as TurnState | undefined) ?? EMPTY_TURN_STATE;
}

export function writeTurnState<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turn: TurnState,
): T {
  const state = { ...session.state };
  if (turn.suspended.length === 0 && turn.queued === undefined && turn.grants.length === 0) {
    delete state[TURN_STATE_KEY];
  } else {
    state[TURN_STATE_KEY] = turn;
  }
  return { ...session, state: Object.keys(state).length === 0 ? undefined : state };
}
