import type { ContextReader } from "#context/key.js";
import { sessionDefinitions } from "#definitions/agent.js";
import type { Harness, HarnessDefinition } from "#public/definitions/harness.js";

// A session's harness stack, and how a stage runs over it. Every layer is one of the agent's
// definitions, in the agent's one ordered list: a later definition wraps the ones before it, so the
// stack, outermost first, is the layers in reverse. The agent's own harness comes last (outermost),
// after each mounted extension's, and eve's own behavior is each stage's `bottom`. A layer with
// `extends: false` ends the stack: nothing under it runs, eve's behavior included.

/** One layer, and where it came from, for errors. */
export interface HarnessLayer {
  readonly definition: HarnessDefinition;
  readonly label: string;
  /** The extension mount it came from, which names the tools it adds. */
  readonly namespace?: string;
}

export interface HarnessStack {
  /** Outermost first. */
  readonly layers: readonly HarnessLayer[];
  /** A layer said `extends: false`: eve's own behavior isn't at the bottom. */
  readonly naked: boolean;
}

export const EMPTY_STACK: HarnessStack = { layers: [], naked: false };

/** The stack harnesses make, outermost first: the agent's, then each extension's. */
export function stackOf(
  harnesses: readonly {
    readonly label: string;
    readonly harness: Harness;
    readonly namespace?: string;
  }[],
): HarnessStack {
  const layers: HarnessLayer[] = [];
  for (const { harness, label, namespace } of harnesses) {
    for (const definition of harness.layers) {
      layers.push({ definition, label, ...(namespace !== undefined && { namespace }) });
      // Nothing is below a naked layer: the extensions after it don't join.
      if (definition.extends === false) return { layers, naked: true };
    }
  }
  return { layers, naked: false };
}

/** The session's stack: the layers among its definitions, outermost first. */
export async function sessionHarness(ctx: Pick<ContextReader, "get">): Promise<HarnessStack> {
  const layers = (await sessionDefinitions(ctx))
    .flatMap((definition) => (definition.layer === undefined ? [] : [definition.layer]))
    .reverse();
  if (layers.length === 0) return EMPTY_STACK;
  return { layers, naked: layers.some((layer) => layer.definition.extends === false) };
}

export type StageName =
  | "next"
  | "model"
  | "tools"
  | "instructions"
  | "context"
  | "request"
  | "admit"
  | "compact";

/** Whether some layer changes `stage` as a function. */
export function hasStage(stack: HarnessStack, stage: StageName): boolean {
  return stack.layers.some((layer) => typeof layer.definition[stage] === "function");
}

/** A stage the stack has nothing below for: a naked harness asked the layers below it. */
export class NothingBelowError extends Error {
  override readonly name = "NothingBelowError";
  constructor(stage: StageName, stack: HarnessStack) {
    super(
      `"${stack.layers.at(-1)?.label ?? "the harness"}" says \`extends: false\`, so its "${stage}" stage has nothing below it to call.`,
    );
  }
}

type StageFn<C, T> = (ctx: C, below: () => Promise<T>) => T | Promise<T>;

function stageFn<C, T>(value: unknown): StageFn<C, T> | undefined {
  return typeof value === "function" ? (value as StageFn<C, T>) : undefined;
}

/**
 * Runs `stage` over the stack: the outermost layer that defines it as a function runs first, and
 * each `below()` runs the next one down, then `bottom`, each at most once. `bottom` is eve's own
 * stage, or under a naked stack what the caller says is below everything (the agent's own tools,
 * or nothing). A layer that defines a stage as a value contributes elsewhere, not here. Every
 * agent runs its stages here, so `ctx` is made only when a layer reads it: an agent with no
 * harness pays for nothing but `bottom`.
 */
export async function runStage<C, T>(
  stack: HarnessStack,
  stage: StageName,
  ctx: () => C,
  bottom: () => Promise<T>,
): Promise<T> {
  const functions = stack.layers.flatMap((layer) => {
    const fn = stageFn<C, T>(layer.definition[stage]);
    return fn === undefined ? [] : [{ fn, label: layer.label }];
  });
  if (functions.length === 0) return await bottom();
  const made = ctx();
  const below = (index: number): (() => Promise<T>) => {
    let result: Promise<T> | undefined;
    return () =>
      (result ??= Promise.resolve().then(() => {
        const layer = functions[index];
        return layer === undefined ? bottom() : layer.fn(made, below(index + 1));
      }));
  };
  return await below(0)();
}
