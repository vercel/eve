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

export class SessionStateCursor {
  readonly sessionWritable: WritableStream<Uint8Array>;

  private readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
  private values: SessionStateValues;
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

  async advance<T extends SessionStateTransition>(
    step: (state: SessionStepState) => Promise<T>,
  ): Promise<T> {
    const { serializedContext, sessionState } = this.values;
    return await this.adopt(
      () => step({ serializedContext, sessionState, sessionWritable: this.sessionWritable }),
      { withHistory: false },
    );
  }

  async advanceWithHistory<T extends SessionStateTransition>(
    step: (state: SessionHistoryStepState) => Promise<T>,
  ): Promise<T> {
    return await this.adopt(() => step({ ...this.values, sessionWritable: this.sessionWritable }), {
      withHistory: true,
    });
  }

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
    const tokens = new Set(sessionHookTokens(base));
    if (sessionHookTokens(next).some((token) => !tokens.has(token))) return false;
    this.values = next;
    this.adopted++;
    return true;
  }

  private async adopt<T extends SessionStateTransition>(
    run: () => Promise<T>,
    options: { readonly withHistory: boolean },
  ): Promise<T> {
    const base = this.values;
    this.running++;
    try {
      const result = await run();
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
