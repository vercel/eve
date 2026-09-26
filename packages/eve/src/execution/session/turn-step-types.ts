import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { TaskKernelCall } from "#execution/tasks/calls.js";
import type { SettledTurn } from "#harness/types.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Trusted runtime-action results collected by the session owner. */
export interface RuntimeActionResultStepInput {
  readonly acceptedAtMsByCallId?: Readonly<Record<string, number>>;
  readonly results: readonly RuntimeActionResult[];
}

/**
 * Everything one turn step may consume. A step can carry a delivery and a
 * set of runtime results together: steering accepted while a blocking action
 * was in flight is appended ahead of that action's result in the same step.
 */
export interface TurnStepPayload {
  readonly control?: "clear" | "compact";
  readonly delivery?: DeliverHookPayload;
  readonly runtimeResults?: RuntimeActionResultStepInput;
}

/** Input for one atomic, session-owner-executed turn step. */
export interface TurnStepInput {
  readonly abortSignal?: AbortSignal;
  readonly steeringSignal?: AbortSignal;
  readonly input: TurnStepPayload | undefined;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

interface DurableStepResultFields {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Result returned by a session-mutating turn step. */
export type DurableStepResult = (
  | {
      readonly action: "continue" | "done";
      readonly output?: unknown;
      readonly isError?: boolean;
      readonly usage?: TokenUsage;
      readonly usageDelta?: TokenUsage;
    }
  | { readonly action: "cancelled" | "steered" }
  /** The model ended the turn while its principal's tasks work; the turn waits for them. */
  | { readonly action: "held"; readonly taskIds: readonly string[] }
  | {
      readonly action: "park";
      readonly authorizationAttemptIds?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly pendingCoordinationCallIds?: readonly string[];
      readonly pendingKernelCalls?: readonly TaskKernelCall[];
      readonly settled?: SettledTurn;
    }
) &
  DurableStepResultFields;

/** The only two ways a locally executed conversational turn can settle. */
export type TurnOutcome =
  | {
      readonly kind: "done";
      readonly output: unknown;
      readonly isError?: boolean;
      readonly usage?: TokenUsage;
      readonly usageDelta?: TokenUsage;
    }
  | {
      readonly authorizationAttemptIds?: readonly string[];
      readonly cancelled?: true;
      readonly kind: "park";
      readonly settled?: SettledTurn;
    };
