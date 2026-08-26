import type { DeliverHookPayload } from "#channel/types.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
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
  readonly agentNodeId?: string;
  readonly controlToken: string;
  readonly defaultBundle?: unknown;
  readonly parentWritable: WritableStream<Uint8Array>;

  private lastReportedContinuationToken: string;

  constructor(input: {
    readonly agentNodeId?: string;
    readonly controlToken: string;
    readonly defaultBundle?: unknown;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  }) {
    super({ serializedContext: input.serializedContext, sessionState: input.sessionState });
    this.agentNodeId = input.agentNodeId;
    this.controlToken = input.controlToken;
    this.defaultBundle = input.defaultBundle;
    this.lastReportedContinuationToken = input.sessionState.continuationToken;
    this.parentWritable = input.parentWritable;
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
      agentNodeId: this.agentNodeId,
      defaultBundle: this.defaultBundle,
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
  ): Promise<void> {
    this.adoptState({
      ...transition,
      serializedContext:
        transition.serializedContext === undefined || this.defaultBundle === undefined
          ? transition.serializedContext
          : { ...transition.serializedContext, "eve.bundle": this.defaultBundle },
    });
    await this.send({
      action: {
        ...action,
        serializedContext: this.serializedContext,
        sessionState: this.sessionState,
      },
      bufferedDeliveries: bufferedDeliveries.length === 0 ? undefined : [...bufferedDeliveries],
      kind: "turn-result",
    });
  }

  /** Sends one control payload to the session driver. */
  async send(payload: TurnControlPayload): Promise<void> {
    await sendTurnControlStep({ controlToken: this.controlToken, payload });
  }
}
