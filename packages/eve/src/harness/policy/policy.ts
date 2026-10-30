import type { SessionStateMap } from "#harness/types.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { Memo } from "#dynamic/definition.js";
import type { JsonValue } from "#shared/json.js";

// A harness policy is a function of the session that says what should happen next. eve
// evaluates it where it decides, and applies what it returns through its own gates. eve's loop is
// one policy among others; nothing outside the harness can install another yet.

/** A value, or a function eve calls only where it needs the value. */
export type Lazy<T> = T | (() => T | Promise<T>);

export async function force<T>(value: Lazy<T> | undefined): Promise<T | undefined> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : value;
}

/** The model step that just ended. */
export interface ModelStep {
  /** The prose the step wrote. */
  readonly text: string | null;
  /** The structured value the step delivered for the turn's output schema. */
  readonly output?: JsonValue;
  /**
   * Every call targeted a tool that ends the turn, each succeeded, and each tool's `endsTurn`
   * accepted its output.
   */
  readonly endsTurn: boolean;
  /** The step called tools: their results, after it in history, are what the model hasn't read. */
  readonly madeCalls: boolean;
}

export interface PolicyTurn {
  readonly id: string;
  /** Notes a policy added to this turn that are still in history. */
  readonly continuations: number;
  /** History ends with tool results the model hasn't read. */
  readonly unread: boolean;
  /** The model step that just ended, where eve decides after one. */
  readonly lastStep?: ModelStep;
}

/** How big the next model call is, as eve estimates it before sending it. */
export interface HistorySize {
  /** The call's estimated input tokens: instructions, tools, and the history. */
  readonly tokens: number;
  /** The model's context window, when eve knows it. */
  readonly window?: number;
}

/** eve's summary of older turns: a checkpoint, and the recent turns whole. */
export type Summarize = (
  history: readonly HarnessModelMessage[],
  options?: {
    /** The call's input tokens to aim under. eve's own threshold when absent. */
    readonly tokens?: number;
  },
) => Promise<HarnessModelMessage[]>;

export interface PolicyContext {
  /** The running turn, or `null` between turns. */
  readonly turn: PolicyTurn | null;
  readonly history: readonly HarnessModelMessage[];
  /** The next model call's size, where eve asks for the history. */
  readonly size?: HistorySize;
  /** `session.compact()` asked for a compaction, where eve asks for the history. */
  readonly compact?: true;
  /** eve's summarizer. Only where eve asks for the history; elsewhere it throws. */
  readonly summarize: Summarize;
  /**
   * Keeps what the policy learns from outside, as a dynamic value's `ctx.memo` does. Each
   * decision (`history`, `next`) keeps what its latest evaluation used. A cache, not a
   * record of effects: a deployment change or a crash can run it again.
   */
  readonly memo: Memo;
  readonly tasks: { readonly working: readonly string[] };
  readonly signal: AbortSignal | undefined;
}

/** What the turn does next. */
export type Next =
  /** Call the model, after showing it `note` when there is one. */
  | { readonly model: { readonly note?: string } }
  /**
   * End the turn with `output`. While the turn's tasks work it can't end: eve waits for them and
   * calls the model with their results. Under an output schema the turn ends with the value the
   * model delivered.
   */
  | { readonly settle: { readonly output: JsonValue | null } }
  /**
   * Call tools: each through the gate a model's call goes through (approval, sign-in, the
   * runtime's own tools), recorded in history as a call the agent made. eve decides again once
   * they've settled.
   */
  | { readonly calls: readonly { readonly tool: string; readonly input?: JsonValue }[] }
  /** End the turn as failed, with `message` for the person. */
  | { readonly fail: { readonly message: string } };

/** What a policy says should be true. A field it leaves out is eve's own. */
export interface Plan {
  /**
   * What the model reads about the past, which becomes the session's history. eve asks before
   * each model call and for `session.compact()`. `undefined` is eve's own: summarize past the
   * threshold, or the history as it is.
   */
  readonly history?: Lazy<readonly HarnessModelMessage[] | undefined>;
  readonly next?: Lazy<Next>;
}

/** Cheap and synchronous: it says what each field is. Work belongs in the lazy fields. */
export type Policy = (ctx: PolicyContext) => Plan;

/** Marks the notes a policy adds, with the turn they continued. */
export const NOTE_KEY = "eve.program";

const NOTES_KEY = "eve.policy.notes";

/**
 * The notes a policy added to `turnId`, counted as they're added, so a compaction that summarizes
 * them away doesn't lift the cap.
 */
export function notesAdded(state: SessionStateMap | undefined, turnId: string): number {
  const notes = state?.[NOTES_KEY] as
    | { readonly turnId?: string; readonly count?: number }
    | undefined;
  return notes?.turnId === turnId ? (notes.count ?? 0) : 0;
}

/** `session` with one more note counted for `turnId`. */
export function countNote<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turnId: string,
): T {
  const count = notesAdded(session.state, turnId) + 1;
  return { ...session, state: { ...session.state, [NOTES_KEY]: { count, turnId } } };
}

/** The notes policies added to this turn still in `history`, which compaction may have summarized. */
export function continuationsOf(history: readonly HarnessModelMessage[], turnId: string): number {
  return history.filter(
    (message) =>
      message.role === "user" &&
      message.kind === "execution.continuation" &&
      message.metadata?.[NOTE_KEY] === turnId,
  ).length;
}
