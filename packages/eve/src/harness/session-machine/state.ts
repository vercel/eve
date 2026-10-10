import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap, HarnessStepInput } from "#harness/types.js";
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
 * A model step whose calls can't all settle yet: some await an approval, others the runtime.
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
   * its step starts and its budget allows it, as calls the model makes do.
   */
  readonly approved?: readonly InputRequest[];
  /** Workflow and agent calls the runtime runs for the step. */
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  /** The caller whose turn parked the step; `null` when unauthenticated. */
  readonly requester?: SessionAuthContext | null;
}

export interface TurnState {
  /** Input that arrived before it could run: a partial answer, or input behind a policy pass. */
  readonly queued?: HarnessStepInput;
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
