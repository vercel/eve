import type { DurableSessionState } from "#execution/durable-session-store.js";

/** A durable-state transition; absent fields keep the cursor's current value. */
export interface SessionStateTransition {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
}

/**
 * Owns the mutable serialized-context / session-state pair that durable
 * steps thread through a run. Holders adopt each step's transition instead
 * of rebinding both values by hand at every callsite.
 */
export class SessionStateCursor {
  private currentSerializedContext: Record<string, unknown>;
  private currentSessionState: DurableSessionState;

  constructor(input: {
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  }) {
    this.currentSerializedContext = input.serializedContext;
    this.currentSessionState = input.sessionState;
  }

  /** Latest adopted serialized runtime context. */
  get serializedContext(): Record<string, unknown> {
    return this.currentSerializedContext;
  }

  /** Latest adopted durable session state. */
  get sessionState(): DurableSessionState {
    return this.currentSessionState;
  }

  /** Adopts a state transition; fields a step did not change carry forward. */
  adoptState(transition: SessionStateTransition): void {
    this.currentSerializedContext = transition.serializedContext ?? this.currentSerializedContext;
    this.currentSessionState = transition.sessionState ?? this.currentSessionState;
  }
}
