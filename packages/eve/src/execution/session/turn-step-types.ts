import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SettledTurn } from "#harness/types.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
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
  /** Starts a result turn that runs as the tasks' creator and delivers their held results. */
  readonly taskResults?: { readonly creator?: JsonObject };
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
  | {
      readonly action: "park";
      readonly authorizationAttemptIds?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly pendingCoordinationCallIds?: readonly string[];
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
      /** The session expired during the cancelled turn, and ends next. */
      readonly expired?: true;
      readonly kind: "park";
      readonly settled?: SettledTurn;
    };
