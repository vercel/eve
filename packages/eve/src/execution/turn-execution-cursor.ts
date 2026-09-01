import type { DeliverHookPayload } from "#channel/types.js";
import type { TurnControlPayload, TurnResultPayload } from "#execution/turn-control-protocol.js";
import { sendTurnControlStep } from "#execution/turn-control-protocol.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type {
  TurnStepInput,
  TurnStepPayload,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { SettledTurn } from "#harness/types.js";
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
      readonly usageDelta?: TokenUsage;
    }
  | {
      readonly authorizationAttemptIds?: readonly string[];
      readonly authorizationNames?: readonly string[];
      readonly cancelled?: true;
      readonly kind: "park";
      readonly settled?: SettledTurn;
    };

/** Owns the mutable durable state cursor for one active turn workflow. */
export class TurnExecutionCursor extends SessionStateCursor {
  readonly controlToken: string;
  readonly parentWritable: WritableStream<Uint8Array>;

  private lastReportedContinuationToken: string;
  private readonly returnTerminalResult: boolean;

  constructor(input: {
    readonly controlToken: string;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly returnTerminalResult?: boolean;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  }) {
    super({ serializedContext: input.serializedContext, sessionState: input.sessionState });
    this.controlToken = input.controlToken;
    this.lastReportedContinuationToken = input.sessionState.continuationToken;
    this.parentWritable = input.parentWritable;
    this.returnTerminalResult = input.returnTerminalResult === true;
  }

  /** Adopts a state transition and reports any continuation-token change once. */
  async adopt(transition: TurnTransition): Promise<void> {
    this.adoptState(transition);

    const nextToken = transition.sessionState.continuationToken;
    if (nextToken === "" || nextToken === this.lastReportedContinuationToken) return;

    this.lastReportedContinuationToken = nextToken;
    await this.send({ continuationToken: nextToken, kind: "turn-continuation-token" });
  }

  /** Builds the next atomic turn-step input from the cursor's current state. */
  createStepInput(input: TurnStepPayload | undefined, abortSignal?: AbortSignal): TurnStepInput {
    return {
      abortSignal,
      input,
      parentWritable: this.parentWritable,
      serializedContext: this.serializedContext,
      sessionState: this.sessionState,
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
  ): Promise<TurnResultPayload> {
    this.adoptState(transition);
    const result: TurnResultPayload = {
      action: {
        ...action,
        serializedContext: this.serializedContext,
        sessionState: this.sessionState,
      },
      bufferedDeliveries: bufferedDeliveries.length === 0 ? undefined : [...bufferedDeliveries],
      kind: "turn-result",
    };
    if (!this.returnTerminalResult) await this.send(result);
    return result;
  }

  /** Sends one control payload to the session driver. */
  async send(payload: TurnControlPayload): Promise<void> {
    await sendTurnControlStep({ controlToken: this.controlToken, payload });
  }
}
