import type { DurableSessionState } from "#execution/durable-session-store.js";
import type {
  SessionHistoryStepInput,
  SessionStepInput,
} from "#execution/publish-session-events.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import type { OpenTurn } from "#execution/session/open-turn.js";
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
  private readonly record: SessionRecordWriter | undefined;
  private values: SessionStateValues;
  private openTurn: OpenTurn | undefined;
  private readonly settledWaiters: (() => void)[] = [];
  private rerunNext: boolean;
  private adopted = 0;
  private running = 0;

  constructor(
    input: SessionStateValues & {
      readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
      readonly sessionWritable: WritableStream<Uint8Array>;
      readonly open?: OpenTurn;
      readonly record?: SessionRecordWriter;
      readonly rerunFirst?: boolean;
    },
  ) {
    this.inbox = input.inbox;
    this.record = input.record;
    this.openTurn = input.open;
    this.rerunNext = input.rerunFirst === true;
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

  get open(): OpenTurn | undefined {
    return this.openTurn;
  }

  markOpen(open: OpenTurn | undefined): Promise<void> | undefined {
    this.openTurn = open;
    return this.record?.(open);
  }

  async settledStep(): Promise<void> {
    if (this.running === 0) return;
    await new Promise<void>((resolve) => this.settledWaiters.push(resolve));
  }
  async advance<T extends SessionStateTransition>(
    step: (state: SessionStepInput) => Promise<T>,
    turn?: OpenTurnChange<T>,
  ): Promise<T> {
    return await this.adopt(
      () => {
        const { serializedContext, sessionState } = this.values;
        return step({ serializedContext, sessionState, ...this.writing() });
      },
      { turn, withHistory: false },
    );
  }

  async advanceWithHistory<T extends SessionStateTransition>(
    step: (state: SessionHistoryStepInput) => Promise<T>,
    turn?: OpenTurnChange<T>,
  ): Promise<T> {
    return await this.adopt(() => step({ ...this.values, ...this.writing() }), {
      turn,
      withHistory: true,
    });
  }

  async advanceBeside<T extends SessionStateTransition>(
    step: (state: SessionStepInput) => Promise<T>,
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

  private writing(): Pick<SessionStepInput, "rerun" | "sessionWritable"> {
    const rerun = this.rerunNext;
    this.rerunNext = false;
    return { sessionWritable: this.sessionWritable, ...(rerun && { rerun: true }) };
  }
  private async adopt<T extends SessionStateTransition>(
    run: () => Promise<T>,
    options: { readonly turn: OpenTurnChange<T> | undefined; readonly withHistory: boolean },
  ): Promise<T> {
    this.running++;
    try {
      if (options.turn?.before !== undefined) {
        const recorded = this.markOpen(options.turn.before);
        if (recorded !== undefined) await recorded;
      }
      const base = this.values;
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
      const { turn } = options;
      if (turn !== undefined) {
        const recorded = this.markOpen(
          turn.after === undefined ? this.openTurn : turn.after(result),
        );
        if (recorded !== undefined) await recorded;
      }
      return result;
    } finally {
      this.running--;
      if (this.running === 0) for (const settled of this.settledWaiters.splice(0)) settled();
    }
  }
}

type SessionRecordWriter = (open: OpenTurn | undefined) => Promise<void> | undefined;

export interface OpenTurnChange<T> {
  readonly before?: OpenTurn;
  readonly after?: (result: T) => OpenTurn | undefined;
}
