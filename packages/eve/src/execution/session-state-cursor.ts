import { ContinuationHookTokensKey } from "#context/keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { claimSessionHooks, type SessionInbox } from "#execution/session-inbox/inbox.js";
import type { TurnStepInput, TurnStepPayload } from "#execution/turn-step.js";

/** A durable-state transition; absent fields keep the cursor's current value. */
export interface SessionStateTransition {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
}

type SessionHookClaims = Pick<SessionInbox, "claimSessionHook" | "sessionHookTokens">;

/**
 * The one mutable serialized-context / session-state pair owned by the
 * workflow executing a session. Steps return transitions; the cursor adopts
 * them and claims any continuation address a step introduced, so every hook
 * the session answers to is registered before the next step runs.
 */
export class SessionStateCursor {
  readonly parentWritable: WritableStream<Uint8Array>;

  private readonly commandInbox: SessionHookClaims;
  private currentSerializedContext: Record<string, unknown>;
  private currentSessionState: DurableSessionState;

  constructor(input: {
    readonly commandInbox: SessionHookClaims;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  }) {
    this.commandInbox = input.commandInbox;
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

  /** Adopts a transition that cannot have introduced a continuation address. */
  adoptState(transition: SessionStateTransition): void {
    this.currentSerializedContext = transition.serializedContext ?? this.currentSerializedContext;
    this.currentSessionState = transition.sessionState ?? this.currentSessionState;
  }

  /** Adopts a transition after claiming every continuation address it introduced. */
  async adopt(transition: SessionStateTransition): Promise<void> {
    const serializedContext = transition.serializedContext ?? this.currentSerializedContext;
    const sessionState = transition.sessionState ?? this.currentSessionState;
    const recorded = serializedContext[ContinuationHookTokensKey.name];
    const candidates = Array.isArray(recorded)
      ? recorded.filter((token): token is string => typeof token === "string" && token.length > 0)
      : [];
    if (sessionState.continuationToken !== "") candidates.push(sessionState.continuationToken);

    await claimSessionHooks(this.commandInbox, candidates);
    this.adoptState(transition);
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
