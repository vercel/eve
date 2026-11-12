import type { ModelMessage } from "ai";

import type { SessionFrame } from "#dynamic/definition.js";
import type { JsonValue } from "#shared/json.js";
import type { ToolDefinition } from "#tools/definition.js";

// `defineHarness`: the one way to change how an agent runs. A harness is a stack of layers. Each
// layer names the stages it changes; a stage composes only with the same stage below it
// (`below`), and reads the other stages through `ctx.harness`, which is always the whole stack.
// eve's own behavior is the bottom of the stack, and `extends: false` takes it away.

const HARNESS = Symbol.for("eve:harness");

/** What happens next in the turn, as a harness's `next` decides it. */
export type HarnessAction =
  /** Call the model with the request the stack builds, after showing it `note`. */
  | { readonly model: { readonly note?: string } }
  /** End the turn with this reply: text, a structured value, or `null` for none. */
  | { readonly settle: JsonValue }
  /** End the turn as failed, with this message. */
  | { readonly fail: string }
  /** Wait for working tasks; eve's own `next` answers this while tasks run. */
  | { readonly wait: { readonly tasks: readonly string[] } }
  /**
   * Call tools as the turn's own, through the same gate as the model's calls (approval, sign-in,
   * workflow tools). `next` decides again once they settle, before the model reads them.
   */
  | { readonly call: readonly { readonly tool: string; readonly input?: JsonValue }[] };

/** A call in the open turn, the model's or the harness's. */
export interface HarnessCall {
  readonly callId: string;
  readonly tool: string;
  /** Who made it: a model step, or a harness's `call`. */
  readonly by: "model" | "harness";
  readonly status: "requested" | "running" | "settled";
  /** How it settled: `completed`, `failed`, `rejected`, `cancelled`, ... */
  readonly outcome?: string;
  readonly input?: JsonValue;
  readonly output?: JsonValue;
}

/** A tool the model call offers, as a harness reads and filters it. */
export interface HarnessTool {
  readonly name: string;
  readonly description: string;
  /** Reached through `eve__search` and `eve__tool` instead of the tool list. */
  readonly deferred: boolean;
}

/** The tools a model call offers, by name. Return a subset, in any order, with descriptions changed. */
export type HarnessTools = ReadonlyMap<string, HarnessTool>;

/** The model step that just ran, as `next` reads it after the model. */
export interface HarnessStep {
  /** What the model wrote, or `null` when it was narration before a tool that ends the turn. */
  readonly text: string | null;
  /** Every call the step made can end the turn, and did. */
  readonly endsTurn: boolean;
  /** The structured reply the model delivered, for a turn with an output schema. */
  readonly output?: JsonValue;
}

/** What every stage reads: the session as of its latest commit, and the rest of the stack. */
export interface HarnessContext extends SessionFrame {
  /** The text of the open turn's input, or `""` between turns. */
  readonly input: string;
  /** How many notes the harness added in the open turn. */
  readonly continuations: number;
  /** The model step that just ran, when `next` runs after one. */
  readonly lastStep?: HarnessStep;
  /** The open turn's calls, in the order they were made. */
  readonly calls: readonly HarnessCall[];
  /** The conversation as recorded, as of the latest commit. */
  readonly history: readonly ModelMessage[];
  /** The other stages, as the whole stack makes them. */
  readonly harness: {
    tools(): Promise<HarnessTools>;
    instructions(): Promise<readonly string[]>;
  };
}

/** What `compact` reads besides the session: how big the next call is, and eve's summarizer. */
export interface HarnessCompactContext extends HarnessContext {
  /** The next call's input tokens, as eve measures them. */
  readonly tokens: number;
  /** Where eve compacts: `agent.ts`'s `compaction.threshold`, in tokens. */
  readonly threshold: number;
  /** eve's own threshold says compact now. Reading it commits nothing, unlike `below()`. */
  readonly due: boolean;
  /** `session.compact()` asked for it, between turns, whatever the size. */
  readonly requested: boolean;
  /** eve's summary of `messages` (the whole history by default), whatever their size. */
  summarize(messages?: readonly ModelMessage[]): Promise<readonly ModelMessage[]>;
}

/**
 * Who may steer a running turn with a message: `"caller"`, eve's own rule (the turn's own person
 * or delegated caller), or `"nobody"` (every message waits for the next turn). It can only narrow
 * eve's rule; a turn waiting on its own person for an approval or sign-in still hears them.
 */
export interface HarnessAdmission {
  readonly steer: "caller" | "nobody";
}

/** The same stage from the layers under this one, made the first time it's called. */
export type Below<T> = () => Promise<T>;

type Maybe<T> = T | Promise<T>;

/** One layer of a harness. Every stage is optional: one it leaves out is the layers' below. */
export interface HarnessDefinition {
  /** `false`: nothing is below this layer, not eve's own behavior nor any extension's harness. */
  readonly extends?: false;
  /** What happens next: before the turn's first model call, and after each model step. */
  readonly next?: (ctx: HarnessContext, below: Below<HarnessAction>) => Maybe<HarnessAction>;
  /** Tools to add, or a function over the tools the layers below offer. */
  readonly tools?:
    | Readonly<Record<string, ToolDefinition<never, unknown>>>
    | ((ctx: HarnessContext, below: Below<HarnessTools>) => Maybe<HarnessTools>);
  /** An instruction to add, or a function over the system prompt's parts. */
  readonly instructions?:
    | string
    | ((ctx: HarnessContext, below: Below<readonly string[]>) => Maybe<readonly string[]>);
  /** What the model reads of the history on each call. It never changes the recorded history. */
  readonly history?: (
    ctx: HarnessContext,
    below: Below<readonly ModelMessage[]>,
  ) => Maybe<readonly ModelMessage[]>;
  /**
   * Who may steer the running turn, decided at every step and applied by the session loop to the
   * messages that arrive until the next step.
   */
  readonly admit?: (ctx: HarnessContext, below: Below<HarnessAdmission>) => Maybe<HarnessAdmission>;
  /** The history to rewrite to before a call, durably, or `undefined` to keep it. */
  readonly compact?: (
    ctx: HarnessCompactContext,
    below: Below<readonly ModelMessage[] | undefined>,
  ) => Maybe<readonly ModelMessage[] | undefined>;
}

/** A harness: its layers, outermost first. */
export interface Harness {
  readonly [HARNESS]: true;
  readonly layers: readonly HarnessDefinition[];
}

const STAGES = new Set(["extends", "next", "admit", "tools", "instructions", "history", "compact"]);

/**
 * Defines a harness: one layer, or a stack of them (outermost first, harnesses flattened in
 * place). An `agent/harness.ts` or `extension/harness.ts` default-exports it.
 *
 * ```ts
 * export default defineHarness({
 *   history: async (ctx, below) => (await below()).map(trimLargeResults),
 * });
 * ```
 */
export function defineHarness(
  definition: HarnessDefinition | Harness | readonly (HarnessDefinition | Harness)[],
): Harness {
  const layers = (Array.isArray(definition) ? definition : [definition]).flatMap(
    (entry: HarnessDefinition | Harness) => (isHarness(entry) ? entry.layers : [check(entry)]),
  );
  const naked = layers.findIndex((layer) => layer.extends === false);
  if (naked !== -1 && naked !== layers.length - 1) {
    throw new Error(
      "A harness layer with `extends: false` has nothing below it, so it must be the last layer of its stack.",
    );
  }
  if (naked !== -1 && layers[naked]!.next === undefined) {
    throw new Error("A harness with `extends: false` decides every turn itself: define `next`.");
  }
  return { [HARNESS]: true, layers };
}

export function isHarness(value: unknown): value is Harness {
  return typeof value === "object" && value !== null && HARNESS in value;
}

function check(definition: HarnessDefinition): HarnessDefinition {
  if (typeof definition !== "object" || definition === null) {
    throw new Error("defineHarness() takes a layer object, a harness, or an array of them.");
  }
  for (const key of Object.keys(definition)) {
    if (!STAGES.has(key)) {
      throw new Error(
        `A harness layer has no "${key}" stage. Stages: next, admit, tools, instructions, history, compact.`,
      );
    }
  }
  return Object.freeze({ ...definition });
}
