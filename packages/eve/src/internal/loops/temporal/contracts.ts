import { defineSignal } from "@temporalio/workflow";

import type {
  DeliverHookPayload,
  RunSessionLimits,
  SessionAuthContext,
  SessionCapabilities,
} from "#channel/types.js";
import type { TurnOutcome, TurnProgramInput, TurnStepResult } from "#internal/loops/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { RunMode } from "#shared/run-mode.js";

export const TEMPORAL_SESSION_WORKFLOW = "temporalSessionWorkflow";
export const TEMPORAL_TURN_WORKFLOW = "temporalTurnWorkflow";
export const TEMPORAL_LOOP_DELIVERY_SIGNAL = "eve.loop.delivery";

export const temporalLoopDeliverySignal = defineSignal<[unknown]>(TEMPORAL_LOOP_DELIVERY_SIGNAL);

export interface TemporalLoopDelivery {
  readonly auth?: SessionAuthContext | null;
  readonly message: string;
  readonly requestId?: string;
}

export interface TemporalLoopWorkflowInput {
  readonly capabilities?: SessionCapabilities;
  readonly continuationToken: string;
  readonly initialDelivery: DeliverHookPayload;
  readonly limits?: RunSessionLimits;
  readonly mode: RunMode;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}

export interface TemporalLoopCreateSessionInput {
  readonly continuationToken: string;
  readonly limits?: RunSessionLimits;
  readonly sessionId: string;
}

export interface TemporalLoopTurnStepInput {
  readonly input: TurnProgramInput["delivery"];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly stepOrdinal: number;
  readonly turnOrdinal: number;
}

export interface TemporalLoopTurnWorkflowInput {
  readonly input: TurnProgramInput;
  readonly sessionId: string;
  readonly turnOrdinal: number;
}

export interface TemporalLoopActivities {
  createSession(
    input: TemporalLoopCreateSessionInput,
  ): Promise<{ readonly state: DurableSessionState }>;
  executeTurnStep(input: TemporalLoopTurnStepInput): Promise<TurnStepResult>;
  rekeySession(input: {
    readonly continuationToken: string;
    readonly sessionId: string;
  }): Promise<void>;
  settleSession(input: { readonly sessionId: string }): Promise<void>;
}

export type TemporalLoopWorkflow = (input: TemporalLoopWorkflowInput) => Promise<void>;
export type TemporalLoopTurnWorkflow = (
  input: TemporalLoopTurnWorkflowInput,
) => Promise<TurnOutcome>;
