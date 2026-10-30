import type { Memo, SessionFrame } from "#dynamic/definition.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";
import type { HistoryMessage } from "#shared/history-message.js";
import type { JsonValue } from "#shared/json.js";
import type { ToolDefinition } from "#tools/definition.js";

/** A value, or a function eve calls only where it needs the value. */
export type Lazy<T> = T | (() => T | Promise<T>);

/** The model step that just ended. */
export interface HarnessModelStep {
  /** The prose the step wrote. */
  readonly text: string | null;
  /** The structured value the step delivered for the turn's output schema. */
  readonly output?: JsonValue;
  /** Every call the step made targeted a tool that ends the turn, and each did. */
  readonly endsTurn: boolean;
}

/** How big the next model call is, as eve estimates it before sending it. */
export interface HarnessSize {
  /** The call's estimated input tokens: instructions, tools, and the history. */
  readonly tokens: number;
  /** The model's context window, when eve knows it. */
  readonly window?: number;
}

/** A call the running turn made, as the session's view has it. */
export interface HarnessCall {
  readonly callId: string;
  readonly tool: string;
  readonly status: "requested" | "running" | "settled";
  readonly input?: JsonValue;
  /** How it settled: `completed`, `failed`, `rejected`, …. */
  readonly outcome?: string;
  /** Absent for output too large for the view. */
  readonly output?: JsonValue;
  readonly error?: { readonly message: string };
}

/** What a harness reads: the session as of its latest commit, and where eve is deciding. */
export interface HarnessContext extends SessionFrame {
  /**
   * Keeps what the harness learns from outside, as a dynamic value's `ctx.memo` does. A cache,
   * not a record of effects: a deployment change or a crash can run it again.
   */
  readonly memo: Memo;
  /** The history eve is deciding about. */
  readonly history: readonly HistoryMessage[];
  /** Notes this harness added to the running turn that are still in its history. */
  readonly continuations: number;
  /** Model calls the running turn has made. */
  readonly steps: number;
  /** Calls the running turn made, oldest first. */
  readonly calls: readonly HarnessCall[];
  /** The model step that just ended, where eve decides after one. Absent at the turn's start. */
  readonly lastStep?: HarnessModelStep;
  /** The next model call's size, where eve asks for the history. */
  readonly size?: HarnessSize;
  /** `session.compact()` asked for a compaction, where eve asks for the history. */
  readonly compact?: true;
  /**
   * eve's summary of older turns: a checkpoint, then the recent turns whole. `tokens` is the
   * call's size to aim under; eve's own threshold when absent. Only in `history`; elsewhere it
   * throws.
   */
  summarize(
    history: readonly HistoryMessage[],
    options?: { readonly tokens?: number },
  ): Promise<HistoryMessage[]>;
}

/** What the turn does next. */
export type HarnessNext =
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

/**
 * What the agent is for its next model call. A field it leaves out is eve's own: the agent's model,
 * eve's default prompt, and the declared tools with eve's.
 */
export interface HarnessAgent {
  /** The model. `declared(ctx)`'s `model` is the agent's. */
  readonly model?: Lazy<PublicAgentDynamicModelResult | HarnessDeclaredModel | null | undefined>;
  /**
   * The system prompt, all of it. A string is the whole prompt; an array's entries join, and
   * empty ones are skipped. `builtins(ctx).prompt` renders eve's parts from `declared(ctx)`. eve
   * puts its own note first only when a retry dropped a tool the provider rejected.
   */
  readonly instructions?: Lazy<string | readonly string[] | undefined>;
  /**
   * Every tool the model is offered: the harness's own, `declared(ctx).tools` entries, and
   * `builtins(ctx).tools` entries, under their names. Leaving out an `eve__` tool turns off what
   * it serves: without `eve__skill` skills don't load, without `eve__task_wait` the model can't
   * wait on tasks (the turn still waits for them), and without `eve__reply` the model can't
   * deliver a structured result, so the harness settles the turn itself.
   */
  readonly tools?: Lazy<HarnessTools | undefined>;
}

/** A tool the model is offered: the harness's own, or one the agent or eve provides. */
export type HarnessTools = Readonly<
  // oxlint-disable-next-line typescript/no-explicit-any -- any tool, whatever its input and output.
  Record<string, ToolDefinition<any, any> | HarnessDeclaredTool | HarnessBuiltinTool>
>;

/** What the agent's files declare, as data. `declared(ctx)` evaluates it only when asked. */
export interface HarnessDeclaredAgent {
  /** `agent` is the agent's own instructions; each `agent/instructions/` file is there by slug. */
  readonly instructions: Readonly<Record<string, HarnessDeclaredInstructions>>;
  readonly skills: readonly HarnessDeclaredSkill[];
  /** Tools by name, including eve's default tools (each fills an `agent/tools/` slot). */
  readonly tools: Readonly<Record<string, HarnessDeclaredTool>>;
  /** The workspace the agent's files describe, for `builtins(ctx).prompt.workspace`. */
  readonly workspace?: HarnessWorkspace;
  /** The agent's model; returning it as `agent.model` leaves the choice to the agent. */
  readonly model: HarnessDeclaredModel;
}

export interface HarnessDeclaredInstructions {
  readonly content: string;
  readonly role: "system" | "user";
}

export interface HarnessDeclaredSkill {
  readonly name: string;
  readonly description: string;
  readonly deferred: boolean;
  /** The skill's instructions, as `eve__skill` loads them. */
  load(): Promise<string>;
}

/**
 * A tool the agent declares. Offered under its own name, it runs as declared, with its approval;
 * a copy may change its `description`.
 */
export interface HarnessDeclaredTool {
  readonly name: string;
  readonly description: string;
  readonly deferred?: boolean;
  readonly [DECLARED]: string;
}

/** The agent's own model. */
export interface HarnessDeclaredModel {
  readonly [DECLARED]: "model";
}

/** One of eve's own tools. */
export interface HarnessBuiltinTool {
  readonly name: string;
  readonly [BUILTIN]: string;
}

/** A workspace, as eve's workspace prompt reads it. */
export interface HarnessWorkspace {
  readonly [DECLARED]: "workspace";
}

/** What eve adds for its own features: its `eve__` tools, and its prompt, rendered from data. */
export interface HarnessBuiltins {
  /**
   * `eve__skill`, `eve__search`, `eve__tool`, `eve__task_wait`, `eve__task_cancel`, and
   * `eve__reply`. Each is offered where it serves something: a skill, a deferred tool or
   * connection, a task, an output schema.
   */
  readonly tools: Readonly<Record<string, HarnessBuiltinTool>>;
  readonly prompt: {
    /** The skills section: the skills that aren't deferred. */
    skills(skills: readonly HarnessDeclaredSkill[]): string;
    workspace(workspace: HarnessWorkspace | undefined): string;
    /** The note on parallel tool calls, when there are tools. */
    tools(tools: HarnessDeclaredAgent["tools"]): string;
    /** The note on tasks, when the session offers them. */
    tasks(): string;
    /** eve's whole default prompt for `files`. */
    instructions(files: HarnessDeclaredAgent): string | readonly string[];
  };
}

export const DECLARED: unique symbol = Symbol.for("eve.harness.declared") as never;
export const BUILTIN: unique symbol = Symbol.for("eve.harness.builtin") as never;

/** What a harness says should be true. A field it leaves out, or returns `undefined` for, is eve's. */
export interface HarnessPlan {
  readonly agent?: HarnessAgent;
  /**
   * What the model reads about the past, which becomes the session's history. eve asks before
   * each model call and for `session.compact()`. A change to messages the model hasn't read yet
   * joins the history; a change to ones it has read is a rewrite, which eve checks. Asked again
   * about what it returned, it must return the same. `undefined` is eve's own: summarize past the
   * threshold, or the history as it is.
   */
  readonly history?: Lazy<readonly HistoryMessage[] | undefined>;
  /**
   * What the turn does: at its start, before the model has run, and after each model step. At
   * the start, `{ settle }` ends the turn without calling the model, and its output is the reply.
   */
  readonly next?: Lazy<HarnessNext | undefined>;
}

/** Cheap and synchronous: it says what each field is. Work belongs in the lazy fields. */
export type Harness = (ctx: HarnessContext) => HarnessPlan;

const HARNESS: unique symbol = Symbol.for("eve.harness");

/** An opaque `defineHarness()` value. */
export interface HarnessDefinition {
  readonly [HARNESS]: Harness;
}

/**
 * Experimental. Defines how the agent's turns run, in `agent/harness.ts`. eve calls the function
 * wherever it decides, and applies what it returns through the checks no harness can change:
 * approvals, budgets, the turn's tasks, and a bounded number of notes per turn.
 *
 * ```ts
 * import { defineHarness } from "eve";
 *
 * export default defineHarness((ctx) => ({
 *   next: () =>
 *     ctx.lastStep?.text?.includes("[source]") === false && ctx.continuations === 0
 *       ? { model: { note: "Cite a source for each claim." } }
 *       : undefined,
 * }));
 * ```
 */
export function defineHarness(harness: Harness): HarnessDefinition {
  if (typeof harness !== "function") {
    throw new Error(
      "defineHarness() takes a function: defineHarness((ctx) => ({ next, history }))",
    );
  }
  const definition = { [HARNESS]: harness };
  stampDefinitionKey(definition, "harness");
  return definition;
}

/** The function a `defineHarness()` value holds, or `undefined` for anything else. */
export function harnessOf(value: unknown): Harness | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const harness = (value as Partial<HarnessDefinition>)[HARNESS];
  return typeof harness === "function" ? harness : undefined;
}
