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

export interface PolicyContext {
  /** The running turn, or `null` between turns. */
  readonly turn: PolicyTurn | null;
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

export interface Plan {
  readonly next?: Lazy<Next>;
}

/** Cheap and synchronous: it says what each field is. Work belongs in the lazy fields. */
export type Policy = (ctx: PolicyContext) => Plan;
