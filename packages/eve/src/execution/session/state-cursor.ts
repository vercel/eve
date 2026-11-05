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
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type { HarnessModelMessage } from "#harness/messages.js";

/**
 * The one set of session values owned by the workflow executing a session.
 * Steps run against it and return deltas; the cursor applies each to the
 * values its step was given and claims any continuation address the step
 * introduced, so every hook the session answers to is registered before the
 * next step runs. Beside the values it holds where the open turn goes on, which the loop changes
 * only through the steps it runs.
 */
export class SessionStateCursor {
  readonly sessionWritable: WritableStream<Uint8Array>;

  private readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
  private readonly record: SessionRecordWriter | undefined;
  private values: SessionStateValues;
  private openTurn: OpenTurn | undefined;
  /** Run messages the session read since its last record. */
  private consumedSince: WorkflowToolRunMessage[] = [];
  /** Who waits for no step to be running, and the last one adopted. */
  private readonly settledWaiters: (() => void)[] = [];
  /** The next step runs again a step a stopped process left, whose lines the stream holds. */
  private rerunNext: boolean;
  /** Session steps adopted so far, and those still running. */
  private adopted = 0;
  private running = 0;

  constructor(
    input: SessionStateValues & {
      readonly inbox: Pick<SessionInboxOwnership, "claimSessionHooks">;
      readonly sessionWritable: WritableStream<Uint8Array>;
      /** Where the open turn goes on as the session starts. */
      readonly open?: OpenTurn;
      /**
       * Runs once each step's values are adopted, and before a step that changes where the open
       * turn goes on, before the session goes on: a host that keeps sessions saves it here.
       */
      readonly record?: SessionRecordWriter;
      /**
       * The stream holds lines past these values, which a process that stopped inside a step
       * wrote: the first step runs again (`SessionStepInput.rerun`) and folds them.
       */
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

  /** Where the open turn goes on, as of the last step adopted; none between turns. */
  get open(): OpenTurn | undefined {
    return this.openTurn;
  }

  /**
   * Run messages the session handled outside a step that names them (it answered them, or had
   * nothing to do with them): recorded at once, so a restore doesn't deliver them again.
   */
  async consumed(messages: readonly WorkflowToolRunMessage[]): Promise<void> {
    this.consumedSince.push(...messages);
    await this.writeRecord();
  }

  /** Resolves once no session step is running and the last one is adopted and recorded. */
  async settledStep(): Promise<void> {
    if (this.running === 0) return;
    await new Promise<void>((resolve) => this.settledWaiters.push(resolve));
  }

  /**
   * Runs a session-changing step against the current context and session
   * state and adopts the delta it returns. The step is not given the history,
   * which is the bulk of a long session, so its Workflow step input stays
   * small; it cannot change the history either.
   */
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

  /** {@link advance} for a step that reads or changes the history, such as a turn. */
  async advanceWithHistory<T extends SessionStateTransition>(
    step: (state: SessionHistoryStepInput) => Promise<T>,
    turn?: OpenTurnChange<T>,
  ): Promise<T> {
    return await this.adopt(() => step({ ...this.values, ...this.writing() }), {
      turn,
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
    step: (state: SessionStepInput) => Promise<T>,
    wanted: () => boolean,
  ): Promise<boolean> {
    const base = this.values;
    const adopted = this.adopted;
    // It never reruns a stopped step: its delta may be dropped, and the fold with it.
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
    await this.writeRecord();
    return true;
  }

  private async writeRecord(): Promise<void> {
    const consumed = this.consumedSince;
    this.consumedSince = [];
    await this.record?.({ consumed, open: this.openTurn });
  }

  /** Where the next step writes, and whether it runs again a step a stopped process left. */
  private writing(): Pick<SessionStepInput, "rerun" | "sessionWritable"> {
    const rerun = this.rerunNext;
    this.rerunNext = false;
    return { sessionWritable: this.sessionWritable, ...(rerun && { rerun: true }) };
  }

  /**
   * A delta describes a change to exactly the values its step was given, so
   * values that another step changed in the meantime are a sequencing bug,
   * never a merge.
   */
  private async adopt<T extends SessionStateTransition>(
    run: () => Promise<T>,
    options: { readonly turn: OpenTurnChange<T> | undefined; readonly withHistory: boolean },
  ): Promise<T> {
    this.running++;
    try {
      // Recorded before the step runs, so a restore runs it again with what it reads.
      if (options.turn?.before !== undefined) {
        this.openTurn = options.turn.before;
        this.consumedSince.push(...(options.turn.consumes ?? []));
        await this.writeRecord();
      }
      const base = this.values;
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
      const { turn } = options;
      if (turn?.after !== undefined) this.openTurn = turn.after(result);
      if (turn?.before === undefined) this.consumedSince.push(...(turn?.consumes ?? []));
      this.adopted++;
      await this.writeRecord();
      return result;
    } finally {
      this.running--;
      if (this.running === 0) for (const settled of this.settledWaiters.splice(0)) settled();
    }
  }
}

/** What the cursor records: where the open turn goes on, and the run messages read since. */
type SessionRecordWriter = (record: {
  readonly open: OpenTurn | undefined;
  readonly consumed: readonly WorkflowToolRunMessage[];
}) => Promise<void>;

/**
 * What a step changes in the session's record: where the open turn goes on while it runs
 * (recorded before it runs) and once its result is adopted, and the run messages it reads, which
 * the record before it runs reflects when it has one, or else the one after.
 */
export interface OpenTurnChange<T> {
  readonly before?: OpenTurn;
  readonly after?: (result: T) => OpenTurn | undefined;
  readonly consumes?: readonly WorkflowToolRunMessage[];
}
