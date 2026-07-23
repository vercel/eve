import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { sendTurnControlStep } from "#execution/turn-control-protocol.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { TurnStepInput } from "#execution/durable-session-migrations/turn-workflow.js";
import type { TokenUsage } from "#shared/token-usage.js";

interface TurnTransition {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

type TurnTerminalAction =
  | {
      readonly isError?: boolean;
      readonly kind: "done";
      readonly output: unknown;
      readonly usage?: TokenUsage;
    }
  | {
      readonly authorizationNames?: readonly string[];
      readonly cancelled?: true;
      readonly kind: "park";
    };

/** Owns the mutable durable state cursor for one active turn workflow. */
export class TurnExecutionCursor {
  readonly controlToken: string;
  readonly parentWritable: WritableStream<Uint8Array>;

  private currentSerializedContext: Record<string, unknown>;
  private currentSessionState: DurableSessionState;
  private lastReportedContinuationToken: string;

  constructor(input: {
    readonly controlToken: string;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  }) {
    this.controlToken = input.controlToken;
    this.currentSerializedContext = input.serializedContext;
    this.currentSessionState = input.sessionState;
    this.lastReportedContinuationToken = input.sessionState.continuationToken;
    this.parentWritable = input.parentWritable;
  }

  /** Latest serialized runtime context adopted by the active turn. */
  get serializedContext(): Record<string, unknown> {
    return this.currentSerializedContext;
  }

  /** Latest durable session state adopted by the active turn. */
  get sessionState(): DurableSessionState {
    return this.currentSessionState;
  }

  /** Adopts a state transition and reports any continuation-token change once. */
  async adopt(transition: TurnTransition): Promise<void> {
    this.setState(transition);

    const nextToken = transition.sessionState.continuationToken;
    if (nextToken === "" || nextToken === this.lastReportedContinuationToken) return;

    this.lastReportedContinuationToken = nextToken;
    await this.send({ continuationToken: nextToken, kind: "turn-continuation-token" });
  }

  /** Builds the next atomic turn-step input from the cursor's current state. */
  createStepInput(input: HookPayload | undefined, abortSignal?: AbortSignal): TurnStepInput {
    return {
      abortSignal,
      input,
      parentWritable: this.parentWritable,
      serializedContext: this.currentSerializedContext,
      sessionState: this.currentSessionState,
    };
  }

  /**
   * Adopts a terminal turn transition and publishes it as the turn result.
   * The result already carries the final session state, so no separate
   * continuation-token update is sent.
   */
  async finish(
    transition: TurnTransition,
    action: TurnTerminalAction,
    bufferedDeliveries: readonly DeliverHookPayload[],
  ): Promise<void> {
    this.setState(transition);
    await this.send({
      action: {
        ...action,
        serializedContext: this.currentSerializedContext,
        sessionState: this.currentSessionState,
      },
      bufferedDeliveries: bufferedDeliveries.length === 0 ? undefined : [...bufferedDeliveries],
      kind: "turn-result",
    });
  }

  /** Sends one control payload to the session driver. */
  async send(payload: TurnControlPayload): Promise<void> {
    await sendTurnControlStep({ controlToken: this.controlToken, payload });
  }

  private setState(transition: TurnTransition): void {
    this.currentSerializedContext = transition.serializedContext ?? this.currentSerializedContext;
    this.currentSessionState = transition.sessionState;
  }
}
