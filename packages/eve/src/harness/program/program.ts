import type { HarnessModelMessage } from "#harness/messages.js";
import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type { JsonValue } from "#shared/json.js";

// A session program is a function of the session that says what should happen next. eve
// evaluates it where it decides, and applies what it returns through its own gates. eve's loop is
// one program among others; nothing outside the harness can install another yet.

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
}

export interface ProgramTurn {
  readonly id: string;
  /** Notes a program added to this turn that are still in history. */
  readonly continuations: number;
  /** History ends with tool results the model hasn't read. */
  readonly unread: boolean;
  /** The model step that just ended, where eve decides after one. */
  readonly lastStep?: ModelStep;
}

export interface NativeCompactionOptions {
  readonly model?: PublicAgentStaticModelDefinition;
  readonly instructions?: string;
}

/** Where eve has to shrink the history: what asked, and eve's own way of doing it. */
export interface Compaction {
  /** `automatic`: the prompt eve measured is over the threshold. `manual`: `session.compact()`. */
  readonly reason: "automatic" | "manual";
  /**
   * eve's compaction: older turns become a summary checkpoint, and recent ones stay whole.
   * `options` choose the summary model and extend its prompt.
   */
  native(
    history: readonly HarnessModelMessage[],
    options?: NativeCompactionOptions,
  ): Promise<HarnessModelMessage[]>;
}

export interface ProgramContext {
  /** The running turn, or `null` between turns. */
  readonly turn: ProgramTurn | null;
  readonly history: readonly HarnessModelMessage[];
  /** Present where eve has to shrink the history. */
  readonly compaction?: Compaction;
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
  | { readonly settle: { readonly output: JsonValue | null } };

/** What a program says should be true. A field it leaves out is eve's own. */
export interface Plan {
  /**
   * The history the session keeps. eve reads it only where it has to shrink the history, inside
   * the context change it opens there, and checks it unless it's what `compaction.native`
   * returned.
   */
  readonly history?: Lazy<readonly HarnessModelMessage[]>;
  readonly next?: Lazy<Next>;
}

/** Cheap and synchronous: it says what each field is. Work belongs in the lazy fields. */
export type Program = (ctx: ProgramContext) => Plan;
