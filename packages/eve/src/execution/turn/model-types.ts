import type { HookPayload, RuntimeActionResultHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/session/state.js";
import type { SettledTurn, StepResult } from "#harness/types.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";

export interface ModelSettlement {
  readonly events: readonly MessageStreamEvent[];
  readonly emissionAfter: HarnessEmissionState;
}

export type ModelPayload =
  | Exclude<HookPayload, RuntimeActionResultHookPayload>
  | {
      readonly kind: "runtime-action-result";
      readonly acceptedAtMsByCallId?: Readonly<Record<string, number>>;
      readonly results: readonly RuntimeActionResult[];
    };

export interface ModelInput {
  readonly input: ModelPayload | undefined;
  readonly abortSignal?: AbortSignal;
  readonly events: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

export type ModelOutcome =
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
  | { readonly action: "dispatch-workflow-tasks"; readonly pendingTaskCallIds: readonly string[] };

export type ModelResult = ModelOutcome & {
  readonly settlement?: ModelSettlement;
  readonly cancellationState?: DurableSessionState;
  readonly cancellationContext?: Record<string, unknown>;
  readonly sleepDurationMs?: number;
  readonly backgroundTasks?: StepResult["backgroundTasks"];
  readonly sessionState: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
};
