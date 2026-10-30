import type { DurableSessionState } from "#execution/durable-session-store.js";
import type {
  SessionHistoryStepState,
  SessionStepState,
} from "#execution/publish-session-events.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import {
  applySessionStateDelta,
  type SessionStateTransition,
  type SessionStateValues,
} from "#execution/session/state-delta.js";
import type { SessionInboxOwnership } from "#execution/session-inbox/inbox.js";
import type { HarnessModelMessage } from "#harness/messages.js";

/**
 * The one set of session values owned by the workflow executing a session.
 * Steps run against it and return deltas; the cursor applies each to the
 * values its step was given and claims any continuation address the step
 * introduced, so every hook the session answers to is registered before the
 * next step runs.
 */
export class SessionStateCursor {
  readonly sessionWritable: WritableStream<Uint8Array>;

  private readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
  private values: SessionStateValues;
  /** Session steps adopted so far, and those still running. */
  private adopted = 0;
  private running = 0;

  constructor(
    input: SessionStateValues & {
      readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
      readonly sessionWritable: WritableStream<Uint8Array>;
    },
  ) {
    this.inbox = input.inbox;
    this.sessionWritable = input.sessionWritable;
    this.values = {
      history: input.history,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }

  get serializedContext(): Record<string, unknown> {
    return this.values.serializedContext;
  }

  get sessionState(): DurableSessionState {
    return this.values.sessionState;
  }

  get history(): HarnessModelMessage[] {
    return this.values.history;
  }

  /**
   * Runs a session-changing step against the current context and session
   * state and adopts the delta it returns. The step is not given the history,
   * which is the bulk of a long session, so its Workflow step input stays
   * small; it cannot change the history either.
   */
  async advance<T extends SessionStateTransition>(
    step: (state: SessionStepState) => Promise<T>,
  ): Promise<T> {
    const { serializedContext, sessionState } = this.values;
    return await this.adopt(
      () => step({ serializedContext, sessionState, sessionWritable: this.sessionWritable }),
      { withHistory: false },
    );
  }

  /** {@link advance} for a step that reads or changes the history, such as a turn. */
  async advanceWithHistory<T extends SessionStateTransition>(
    step: (state: SessionHistoryStepState) => Promise<T>,
  ): Promise<T> {
    return await this.adopt(() => step({ ...this.values, sessionWritable: this.sessionWritable }), {
      withHistory: true,
    });
  }

  /**
   * Runs a step beside the session's own steps, which do not wait for it.
   * Its delta applies only while `wanted()` holds, no other step ran or is
   * running meanwhile, and it adds no session address; otherwise it is
   * dropped and this returns `false`. A step run this way must leave nothing
   * that dropping its delta would lose for good.
   */
  async advanceBeside<T extends SessionStateTransition>(
    step: (state: SessionStepState) => Promise<T>,
    wanted: () => boolean,
  ): Promise<boolean> {
    const base = this.values;
    const adopted = this.adopted;
    const result = await step({
      serializedContext: base.serializedContext,
      sessionState: base.sessionState,
      sessionWritable: this.sessionWritable,
    });
    if (!wanted() || this.adopted !== adopted || this.running > 0) return false;
    if (result.stateDelta.history !== undefined) {
      throw new Error("A session step that was not given the history cannot change it.");
    }
    const next = applySessionStateDelta(base, result.stateDelta);
    // Applied synchronously, so no session step can start between the checks and the change;
    // claiming a new address would need an await.
    const tokens = new Set(sessionHookTokens(base));
    if (sessionHookTokens(next).some((token) => !tokens.has(token))) return false;
    this.values = next;
    this.adopted++;
    return true;
  }

  /**
   * A delta describes a change to exactly the values its step was given, so
   * values that another step changed in the meantime are a sequencing bug,
   * never a merge.
   */
  private async adopt<T extends SessionStateTransition>(
    run: () => Promise<T>,
    options: { readonly withHistory: boolean },
  ): Promise<T> {
    const base = this.values;
    this.running++;
    try {
      const result = await run();
      // Diffed against a history it never had, the delta would replace the whole history.
      if (!options.withHistory && result.stateDelta.history !== undefined) {
        throw new Error("A session step that was not given the history cannot change it.");
      }
      const next = applySessionStateDelta(base, result.stateDelta);
      await this.inbox.claimSessionHooks(sessionHookTokens(next));
      if (this.values !== base) {
        throw new Error("Session state changed while a step ran, so its state delta cannot apply.");
      }
      this.values = next;
      this.adopted++;
      return result;
    } finally {
      this.running--;
    }
  }
}
