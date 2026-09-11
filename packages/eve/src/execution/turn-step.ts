import type { HookPayload, RuntimeActionResultHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SettledTurn, StepResult } from "#harness/types.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Trusted runtime-action results collected by the session owner. */
export interface RuntimeActionResultStepInput {
  readonly acceptedAtMsByCallId?: Readonly<Record<string, number>>;
  readonly kind: "runtime-action-result";
  readonly results: readonly RuntimeActionResult[];
}

export type TurnStepPayload =
  | Exclude<HookPayload, RuntimeActionResultHookPayload>
  | RuntimeActionResultStepInput;

/** Input for one atomic, session-owner-executed turn step. */
export interface TurnStepInput {
  readonly abortSignal?: AbortSignal;
  readonly input: TurnStepPayload | undefined;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

interface DurableStepResultFields {
  readonly backgroundTaskState?: DurableSessionState;
  readonly backgroundTasks?: StepResult["backgroundTasks"];
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
  | { readonly action: "cancelled" }
  | {
      readonly action: "park";
      readonly authorizationAttemptIds?: readonly string[];
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly pendingCoordinationCallIds?: readonly string[];
      readonly settled?: SettledTurn;
    }
  | {
      readonly action: "dispatch-workflow-tasks";
      readonly pendingTaskCallIds: readonly string[];
    }
) &
  DurableStepResultFields;

interface TurnOutcomeState {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** The only two ways a locally executed conversational turn can settle. */
export type TurnOutcome =
  | (TurnOutcomeState & {
      readonly kind: "done";
      readonly output: unknown;
      readonly isError?: boolean;
      readonly usage?: TokenUsage;
      readonly usageDelta?: TokenUsage;
    })
  | (TurnOutcomeState & {
      readonly authorizationAttemptIds?: readonly string[];
      readonly authorizationNames?: readonly string[];
      readonly cancelled?: true;
      readonly kind: "park";
      readonly settled?: SettledTurn;
    });
