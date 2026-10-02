import type { DeliverHookPayload, TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { WithSessionStateDelta } from "#execution/session/state-delta.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
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

interface DurableStepResultFields {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
}

/** What one turn step's work produces, with the session state it leaves. */
export type DurableStepResult = (
  | {
      readonly action: "continue" | "done";
      readonly output?: unknown;
      readonly isError?: boolean;
      readonly usage?: TokenUsage;
      readonly usageDelta?: TokenUsage;
    }
  | { readonly action: "cancelled" | "steered" }
  /** The model ended the turn while tasks work; the turn waits for them. */
  | { readonly action: "held"; readonly hold: "tasks"; readonly taskIds: readonly string[] }
  /** The turn waits on a sign-in or tool approval it raised. */
  | {
      readonly action: "held";
      readonly authorizationAttemptIds: readonly string[];
      readonly hasPendingInputBatch: boolean;
      readonly hold: "request";
      /** Pending input request ids an answer can resolve. */
      readonly inputRequestIds: readonly string[];
    }
  | {
      readonly action: "park";
      /**
       * `false` when every pending call is a task tool call the session answers
       * itself, so the dispatch step can be skipped. Absent, the step runs.
       */
      readonly hasRunsToDispatch?: boolean;
      readonly pendingCoordinationCallIds?: readonly string[];
      readonly pendingTaskToolCalls?: readonly TaskToolCall[];
      readonly settled?: SettledTurn;
    }
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
