import type { DeliverHookPayload, TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { WithSessionStateDelta } from "#execution/session/state-delta.js";
import type { TurnPause } from "#execution/session/pending-turn-state.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SettledTurn } from "#harness/types.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Trusted runtime-action results collected by the session owner. */
export interface RuntimeActionResultStepInput {
  readonly acceptedAtMsByCallId?: Readonly<Record<string, number>>;
  /** What the `ctx.agent` sessions of the `execute` runs behind these results spent. */
  readonly delegatedUsage?: readonly TokenUsage[];
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
  /** The delegated caller to bind into the context before the step runs; sent on a turn's first step. */
  readonly caller?: TurnCaller;
  readonly steeringSignal?: AbortSignal;
  readonly input: TurnStepPayload | undefined;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
}

/** The session state every step result carries. */
export interface DurableStepResultFields {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
}

/** What one turn step's work produces, with the session state it leaves. */
export type DurableStepResult =
  /** The turn goes on with its next step. */
  (
    | { readonly action: "continue" }
    /** The turn waits on what it paused on, then goes on. */
    | ({ readonly action: "paused" } & TurnPause)
    /** The turn ended and the session parks. `settled` is its answer to a delegated caller. */
    | { readonly action: "parked"; readonly settled?: SettledTurn }
    /** The session ended. */
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
      /** The step compacted the history. */
      readonly compacted?: true;
    };

/** What `turnStep` returns: its result, with the session state as a delta. */
export type TurnStepResult = WithSessionStateDelta<DurableStepResult>;

/** The only two ways a locally executed conversational turn can settle. */
export type TurnOutcome = {
  /**
   * The delegated caller of the latest message the turn read. A caller's
   * later message awaits its reply at its own address, so the turn reports there.
   */
  readonly caller?: TurnCaller;
  /** A step of the turn compacted the history. */
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
      readonly kind: "park";
      readonly settled?: SettledTurn;
    }
);
