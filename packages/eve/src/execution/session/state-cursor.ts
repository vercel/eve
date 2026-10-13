import type { CreateSessionInput } from "#execution/create-session-step.js";
import type { TurnStepInput, TurnStepResult } from "#execution/session/turn-step-types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import {
  applySessionStateDelta,
  type SessionStateTransition,
  type SessionStateValues,
} from "#execution/session/state-delta.js";
import type { SessionInboxOwnership } from "#execution/session-inbox/inbox.js";

/**
 * The one serialized-context / session-state pair owned by the workflow
 * executing a session. Steps run against it and return deltas; the cursor
 * applies each to the state its step was given and claims any continuation
 * address the step introduced, so every hook the session answers to is
 * registered before the next step runs.
 */
export class SessionStateCursor {
  readonly sessionWritable: WritableStream<Uint8Array>;

  private readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
  private values: Omit<SessionStateValues, "sessionState"> & { sessionState?: DurableSessionState };
  private readonly initialSession?: CreateSessionInput;

  constructor(input: {
    readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
    readonly sessionWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState?: DurableSessionState;
    readonly initialSession?: CreateSessionInput;
  }) {
    this.inbox = input.inbox;
    this.initialSession = input.initialSession;
    this.sessionWritable = input.sessionWritable;
    this.values = { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }

  get serializedContext(): Record<string, unknown> {
    return this.values.serializedContext;
  }

  get sessionState(): DurableSessionState {
    if (this.values.sessionState === undefined)
      throw new Error("Session has not run its initial turn.");
    return this.values.sessionState;
  }

  get optionalSessionState(): DurableSessionState | undefined {
    return this.values.sessionState;
  }

  /** The first turn persists its creation and changes together, without a preceding step. */
  async advanceTurn(
    step: (state: SessionStepState) => Promise<TurnStepResult>,
    initialStep: (
      state: Omit<TurnStepInput, "input" | "sessionState"> & {
        readonly initialSession: CreateSessionInput;
      },
    ) => Promise<TurnStepResult>,
  ): Promise<TurnStepResult> {
    if (this.values.sessionState !== undefined) return await this.advance(step);
    if (this.initialSession === undefined)
      throw new Error("Missing initial session configuration.");
    const base = this.values;
    const result = await initialStep({
      serializedContext: base.serializedContext,
      sessionWritable: this.sessionWritable,
      initialSession: this.initialSession,
    });
    const next = applySessionStateDelta(base as SessionStateValues, result.stateDelta);
    await this.inbox.claimSessionHooks(sessionHookTokens(next));
    if (this.values !== base) throw new Error("Session state changed while the initial turn ran.");
    this.values = next;
    return result;
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
    const base = { ...this.values, sessionState: this.sessionState };
    const original = this.values;
    const result = await step(this.stepState());
    const next = applySessionStateDelta(base, result.stateDelta);
    await this.inbox.claimSessionHooks(sessionHookTokens(next));
    if (this.values !== original) {
      throw new Error("Session state changed while a step ran, so its state delta cannot apply.");
    }
    this.values = next;
    return result;
  }

  /** The session's stream and current state, spread into a step's input. */
  private stepState(): SessionStepState {
    return {
      ...this.values,
      sessionState: this.sessionState,
      sessionWritable: this.sessionWritable,
    };
  }
}
