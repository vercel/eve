import type { DurableSessionState } from "#execution/durable-session-store.js";
import type {
  PendingSessionEventDispatch,
  SessionStepState,
} from "#execution/publish-session-events.js";
import { dispatchPendingSessionEventsStep } from "#execution/session/dispatch-pending-step.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import type {
  SessionStateDelta,
  SessionStateTransition,
  SessionStateValues,
} from "#execution/session/state-delta.js";
import type { SessionInboxOwnership } from "#execution/session-inbox/inbox.js";
import { applyValueDelta } from "#shared/value-delta.js";

/**
 * The one serialized-context / session-state pair owned by the workflow
 * executing a session. Steps run against it and return deltas; the cursor
 * applies each to the state its step was given and claims any continuation
 * address the step introduced, so every hook the session answers to is
 * registered before the next step runs.
 *
 * The cursor also carries the dispatches of events written while a step it
 * was running owned the session. It hands them to every step it runs, and a
 * step that owns the full session state runs them first. They are cleared
 * only when the cursor adopts the result of a step that ran them, so a failed
 * or retried step leaves them pending.
 */
export class SessionStateCursor {
  readonly sessionWritable: WritableStream<Uint8Array>;

  private readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
  private values: SessionStateValues;
  private pendingDispatches: readonly PendingSessionEventDispatch[] = [];

  constructor(input: {
    readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
    readonly sessionWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  }) {
    this.inbox = input.inbox;
    this.sessionWritable = input.sessionWritable;
    this.values = { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }

  get serializedContext(): Record<string, unknown> {
    return this.values.serializedContext;
  }

  get sessionState(): DurableSessionState {
    return this.values.sessionState;
  }

  /**
   * Runs a session-changing step against the current state and adopts the
   * delta it returns. A delta describes a change to exactly the state its step
   * was given, so state that another step changed in the meantime is a
   * sequencing bug, never a merge.
   */
  async advance<T extends SessionStateTransition>(
    step: (state: SessionStepState) => Promise<T>,
  ): Promise<T> {
    const base = this.values;
    const result = await step({
      ...base,
      pendingDispatches: this.pendingDispatches,
      sessionWritable: this.sessionWritable,
    });
    const next = applySessionStateDelta(base, result.stateDelta);
    await this.inbox.claimSessionHooks(sessionHookTokens(next));
    if (this.values !== base) {
      throw new Error("Session state changed while a step ran, so its state delta cannot apply.");
    }
    this.values = next;
    // Dispatches deferred while the step ran follow the ones it was given.
    this.pendingDispatches = this.pendingDispatches.slice(result.dispatchedPending ?? 0);
    return result;
  }

  /**
   * Leaves the dispatch of an event written while a step owned the session to
   * the next step that owns it. Call only while that step runs, so `advance`
   * keeps the dispatch pending past the step's result.
   */
  deferDispatch(pending: PendingSessionEventDispatch): void {
    this.pendingDispatches = [...this.pendingDispatches, pending];
  }

  /**
   * Throws if dispatches are pending when the session may hand off. A handoff
   * gives the successor the committed state alone, and a delivery that may
   * start one is read only after the pending dispatches drain.
   */
  assertReadyForHandoff(): void {
    if (this.pendingDispatches.length === 0) return;
    throw new Error(
      `${String(this.pendingDispatches.length)} session event dispatches are still pending before a handoff, which would drop them.`,
    );
  }

  /**
   * Runs pending dispatches in a step of their own. The workflow body calls
   * this before it waits for input, hands off, or ends, so no hook waits for
   * the next input and none is lost with the session.
   */
  async drainPendingDispatches(): Promise<void> {
    if (this.pendingDispatches.length === 0) return;
    await this.advance(dispatchPendingSessionEventsStep);
  }
}

/** Applies a step's delta to the values that step was given. */
export function applySessionStateDelta(
  values: SessionStateValues,
  delta: SessionStateDelta,
): SessionStateValues {
  return {
    serializedContext: applyValueDelta(values.serializedContext, delta.serializedContext),
    sessionState: applyValueDelta(values.sessionState, delta.sessionState),
  };
}
