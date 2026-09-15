import type { DurableSessionState } from "#execution/durable-session-store.js";
import { sessionHookTokens } from "#execution/session-hook-claims.js";
import type { SessionInboxOwnership } from "#execution/session-inbox/inbox.js";
import type { TurnStepInput, TurnStepPayload } from "#execution/turn-step.js";

/** A durable-state transition; absent fields keep the cursor's current value. */
export interface SessionStateTransition {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
}

/**
 * The one mutable serialized-context / session-state pair owned by the
 * workflow executing a session. Steps return transitions; the cursor adopts
 * them and claims any continuation address a step introduced, so every hook
 * the session answers to is registered before the next step runs.
 */
export class SessionStateCursor {
  readonly parentWritable: WritableStream<Uint8Array>;

  private readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
  private currentSerializedContext: Record<string, unknown>;
  private currentSessionState: DurableSessionState;

  constructor(input: {
    readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  }) {
    this.inbox = input.inbox;
    this.parentWritable = input.parentWritable;
    this.currentSerializedContext = input.serializedContext;
    this.currentSessionState = input.sessionState;
  }

  get serializedContext(): Record<string, unknown> {
    return this.currentSerializedContext;
  }

  get sessionState(): DurableSessionState {
    return this.currentSessionState;
  }

  /** Applies a transition after claiming every continuation address it introduced. */
  async apply(transition: SessionStateTransition): Promise<void> {
    const serializedContext = transition.serializedContext ?? this.currentSerializedContext;
    const sessionState = transition.sessionState ?? this.currentSessionState;
    await this.inbox.claimSessionHooks(sessionHookTokens({ serializedContext, sessionState }));
    this.currentSerializedContext = serializedContext;
    this.currentSessionState = sessionState;
  }

  createStepInput(input: TurnStepPayload | undefined, abortSignal?: AbortSignal): TurnStepInput {
    return {
      abortSignal,
      input,
      parentWritable: this.parentWritable,
      serializedContext: this.currentSerializedContext,
      sessionState: this.currentSessionState,
    };
  }
}
