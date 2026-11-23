import type { ModelMessage } from "ai";
import type { RememberedApproval, RememberRequest } from "#approval/evaluation.js";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap, HarnessStepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InteractionRequest } from "#protocol/session-events/families/interaction.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

const TURN_STATE_KEY = "eve.harness.turnState";

export interface StepCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface ApprovalAsk {
  readonly remember?: RememberRequest;
  readonly interactionId: string;
  readonly call: {
    readonly callId: string;
    readonly toolName: string;
    readonly input: JsonObject;
    readonly version?: string;
  };
  readonly request: InteractionRequest;
}

export interface ApprovedCall {
  readonly call: ApprovalAsk["call"];
  readonly interactionId?: string;
  readonly signIns?: readonly AuthorizationChallenge[];
  readonly responder?: SessionAuthContext;
}

export interface SuspendedStep {
  readonly event: StepCoordinates;
  readonly messages: readonly ModelMessage[];
  readonly requests: readonly ApprovalAsk[];
  readonly approved?: readonly ApprovedCall[];
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly endsTurn?: true;
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly requester?: SessionAuthContext | null;
  readonly program?: { readonly callId: string };
}

export type ProgramCallResult =
  | { readonly status: "completed"; readonly output: JsonValue }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly outcome?: "rejected" | "interrupted" | "abandoned";
    };

export interface ProgramUnfinishedCall {
  readonly tool: string;
  readonly outcome: string;
  readonly input: string;
}

export interface RecoveredProgramCall {
  readonly name: string;
  readonly started: boolean;
  readonly outcome?: string;
  readonly output?: JsonValue;
  readonly error?: string;
}

export interface ProgramRun {
  readonly callId: string;
  readonly toolName: string;
  readonly code: string;
  readonly maxSubagents: number;
  readonly event: StepCoordinates;
  readonly security: { readonly maxAgeMs?: number; readonly signingKey: string };
  readonly continuation?: string;
  readonly pending: readonly { readonly interruptionId: string; readonly callId: string }[];
  readonly resolutions: readonly {
    readonly interruptionId: string;
    readonly result: ProgramCallResult;
  }[];
  readonly counts: Readonly<Record<string, number>>;
  readonly agentCalls: number;
  readonly unfinished: readonly ProgramUnfinishedCall[];
  readonly recovered?: Readonly<Record<string, RecoveredProgramCall>>;
}

export interface TurnState {
  readonly queued?: HarnessStepInput;
  readonly suspended: readonly SuspendedStep[];
  readonly remembered: Readonly<Record<string, RememberedApproval>>;
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
