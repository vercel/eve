import type { ModelMessage } from "ai";

import type { SessionFrame } from "#dynamic/definition.js";
import type { JsonValue } from "#shared/json.js";
import type { ToolDefinition } from "#tools/definition.js";
import type { HookEvent, HookEventType } from "./hook.js";

// `defineHarness`: the one way to change how an agent runs. A harness is a stack of layers. Each
// layer names the stages it changes; a stage composes only with the same stage below it
// (`below`), and reads the other stages through `ctx.harness`. eve's own behavior is the bottom
// of the stack, and `extends: false` takes it away. Values (`tools: { ... }`, `instructions`)
// and `on` handlers are collected from every layer instead of wrapping each other.

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

/** A task the session holds: a call the turn doesn't wait on. */
export interface HarnessTask {
  readonly taskId: string;
  /** The tool whose call started it. */
  readonly tool: string;
  /** `running` while a call waits on it; `idle` between calls; `cancelled` once stopped. */
  readonly status: "running" | "idle" | "cancelled";
  /** Results the model hasn't read yet. */
  readonly results: readonly JsonValue[];
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

/** One model call, as `request` reads and returns it. */
export interface HarnessRequest {
  /** The system prompt's parts, in the order the model reads them. */
  readonly instructions: readonly string[];
  /** The messages, laid out: history, each turn's context, and announcements. */
  readonly messages: readonly ModelMessage[];
  /** The tools the call offers. Return a subset to narrow this one call. */
  readonly tools: HarnessTools;
}

/** The model step that just ran, as `next` reads it after the model. */
export interface HarnessStep {
  /** What the model wrote, or `null` when it was narration before a tool that ends the turn. */
  readonly text: string | null;
  /** Every call the step made can end the turn, and did. */
  readonly endsTurn: boolean;
  /** The structured reply the model delivered, for a turn with an output schema. */
  readonly output?: JsonValue;
}

/** Runs `fn` once per key and remembers its result, so a retried step doesn't run it again. */
export type HarnessMemo = <T extends JsonValue>(
  key: JsonValue,
  fn: () => Promise<T> | T,
) => Promise<T>;

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
  /** The session's tasks. */
  readonly tasks: readonly HarnessTask[];
  /** The conversation as recorded, as of the latest commit. */
  readonly history: readonly ModelMessage[];
  readonly memo: HarnessMemo;
  /**
   * The other stages. In `next`, `admit`, `compact`, and `request`, they're the whole stack's. In
   * `tools`, `instructions`, `context`, and `model`, they're the layers below this one.
   */
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
  /**
   * eve's own threshold check says it's time, counting instructions and tools too. Reading it
   * commits nothing, unlike `below()`.
   */
  readonly pastThreshold: boolean;
  /** `session.compact()` asked for it, between turns, whatever the size. */
  readonly requested: boolean;
  /** eve's summary of `messages` (the whole history by default), whatever their size. */
  summarize(messages?: readonly ModelMessage[]): Promise<readonly ModelMessage[]>;
}

/** The message `admit` decides about. */
export interface HarnessDelivery {
  /** Who sent it, as the channel verified them; `null` when nobody was. */
  readonly from: SessionFrame["session"]["auth"]["current"];
  /** Its text. */
  readonly text: string;
}

/**
 * What `admit` reads: the session, and the message that just arrived. A message is decided
 * without reading the conversation, so `history` is empty here and deciding stays cheap.
 */
export interface HarnessAdmitContext extends HarnessContext {
  readonly delivery: HarnessDelivery;
}

/**
 * What a message does: join the running turn, wait for it to end, start a turn of its own, or be
 * dropped. A harness can only narrow eve's rule: a message eve wouldn't let join stays out, and a
 * turn waiting on its own person still hears them.
 */
export interface HarnessAdmission {
  readonly action: "join" | "queue" | "turn" | "drop";
  /** Why, for the person whose message waits or is dropped. */
  readonly reason?: string;
}

/** Handlers for what happens in the session, by event type, run after it's written. */
export type HarnessOn = {
  readonly [K in HookEventType]?: (
    event: HookEvent<K>,
    ctx: HarnessContext,
  ) => void | Promise<void>;
};

/** The same stage from the layers under this one, made the first time it's called. */
export type Below<T> = () => Promise<T>;

type Maybe<T> = T | Promise<T>;

/** One layer of a harness. Every stage is optional: one it leaves out is the layers' below. */
export interface HarnessDefinition {
  /** `false`: nothing is below this layer, not eve's own behavior nor any extension's harness. */
  readonly extends?: false;
  /**
   * What happens next: on new input, after each model step, after the harness's own calls, and
   * when a task's result arrives.
   */
  readonly next?: (ctx: HarnessContext, below: Below<HarnessAction>) => Maybe<HarnessAction>;
  /** The model a call runs, as a gateway model ID. */
  readonly model?: (
    ctx: HarnessContext,
    below: Below<string | undefined>,
  ) => Maybe<string | undefined>;
  /** Tools to add, or a function over the tools the layers below offer. */
  readonly tools?:
    | Readonly<Record<string, ToolDefinition<never, unknown>>>
    | ((ctx: HarnessContext, below: Below<HarnessTools>) => Maybe<HarnessTools>);
  /** An instruction to add, or a function over the system prompt's parts. */
  readonly instructions?:
    | string
    | ((ctx: HarnessContext, below: Below<readonly string[]>) => Maybe<readonly string[]>);
  /**
   * What a turn starts with: messages placed right before its input on every call, made once
   * when the turn starts and kept with it.
   */
  readonly context?: (
    ctx: HarnessContext,
    below: Below<readonly ModelMessage[]>,
  ) => Maybe<readonly ModelMessage[]>;
  /**
   * The last change to a model call before it's sent. What it returns is used once; it never
   * changes the recorded history.
   */
  readonly request?: (ctx: HarnessContext, below: Below<HarnessRequest>) => Maybe<HarnessRequest>;
  /** What a message that arrives does. */
  readonly admit?: (
    ctx: HarnessAdmitContext,
    below: Below<HarnessAdmission>,
  ) => Maybe<HarnessAdmission>;
  /** The history to rewrite to before a call, durably, or `undefined` to keep it. */
  readonly compact?: (
    ctx: HarnessCompactContext,
    below: Below<readonly ModelMessage[] | undefined>,
  ) => Maybe<readonly ModelMessage[] | undefined>;
  /** What to do when something happens. Every layer's handlers run; they don't wrap each other. */
  readonly on?: HarnessOn;
}

/** A harness: its layers, outermost first. */
export interface Harness {
  readonly [HARNESS]: true;
  readonly layers: readonly HarnessDefinition[];
}

const STAGES = new Set([
  "extends",
  "next",
  "model",
  "tools",
  "instructions",
  "context",
  "request",
  "admit",
  "compact",
  "on",
]);

/**
 * Defines a harness: one layer, or a stack of them (outermost first, harnesses flattened in
 * place). An `agent/harness.ts` or `extension/harness.ts` default-exports it.
 *
 * ```ts
 * export default defineHarness({
 *   request: async (ctx, below) => {
 *     const request = await below();
 *     return { ...request, messages: request.messages.map(trimLargeResults) };
 *   },
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
        `A harness layer has no "${key}" stage. Stages: next, model, tools, instructions, context, request, admit, compact, on.`,
      );
    }
  }
  return Object.freeze({ ...definition });
}
