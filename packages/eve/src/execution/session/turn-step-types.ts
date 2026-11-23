import type { ControlDelivery } from "#harness/types.js";
import type { DeliverHookPayload, TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { WithSessionStateDelta } from "#execution/session/state-delta.js";
import type { TurnPause } from "#execution/session/pending-turn-state.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SettledTurn } from "#harness/types.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { SessionHandoverObservation } from "#execution/session-inbox/inbox.js";

export interface RuntimeActionResultStepInput {
  readonly acceptedAtMsByCallId?: Readonly<Record<string, number>>;
  readonly delegatedUsage?: Readonly<Record<string, TokenUsage>>;
  readonly results: readonly RuntimeActionResult[];
}

export interface TurnStepPayload {
  readonly control?: "clear" | "compact";
  readonly controlDelivery?: ControlDelivery;
  readonly delivery?: DeliverHookPayload;
  readonly runtimeResults?: RuntimeActionResultStepInput;
}

export interface TurnStepInput {
  readonly handover?: SessionHandoverObservation;
  readonly abortSignal?: AbortSignal;
  readonly caller?: TurnCaller;
  readonly steeringSignal?: AbortSignal;
  readonly input: TurnStepPayload | undefined;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
  readonly recover?: { readonly error: { readonly name?: string }; readonly stopped?: true };
  readonly rerun?: true;
}

export interface DurableStepResultFields {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
}

export type DurableStepResult = (
  | { readonly action: "continue" }
  | ({ readonly action: "paused" } & TurnPause)
  | { readonly action: "parked"; readonly settled?: SettledTurn }
  | {
      readonly action: "done";
      readonly output?: unknown;
      readonly isError?: boolean;
      readonly usage?: TokenUsage;
      readonly usageDelta?: TokenUsage;
    }
  | { readonly action: "cancelled" }
) &
  DurableStepResultFields & {
    readonly compacted?: true;
  };

export type TurnStepResult = WithSessionStateDelta<DurableStepResult>;

export type TurnOutcome = {
  readonly caller?: TurnCaller;
  readonly compacted?: true;
} & (
  | {
      readonly kind: "done";
      readonly output: unknown;
      readonly isError?: boolean;
      readonly usage?: TokenUsage;
      readonly usageDelta?: TokenUsage;
    }
  | {
      readonly cancelled?: true;
      readonly cancelledBy?: ControlDelivery;
      readonly kind: "park";
      readonly settled?: SettledTurn;
    }
);
