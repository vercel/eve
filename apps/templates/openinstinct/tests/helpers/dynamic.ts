import type { DynamicContext, DynamicSentinel } from "eve";
import { emptySessionView } from "eve/events";
import type { DynamicToolResult, ToolDefinition } from "eve/tools";

type DynamicAuth = DynamicContext["session"]["auth"];

interface TestDynamicContextOptions {
  readonly auth?: DynamicAuth;
  readonly channel?: DynamicContext["channel"];
  readonly sessionId?: string;
  readonly view?: DynamicContext["view"];
}

/** A dynamic-definition context for focused tests. */
export function dynamicContextFor({
  auth = { current: null, initiator: null },
  channel = { kind: "channel:eve", metadata: {} },
  sessionId = "test-session",
  view = emptySessionView(),
}: TestDynamicContextOptions = {}): DynamicContext {
  return {
    channel,
    memo: async (_key, fn) =>
      fn({ abortSignal: new AbortController().signal, idempotencyKey: "memo" }),
    async messages() {
      return [];
    },
    model: { id: "test-model" },
    now: new Date("2026-01-01T00:00:00.000Z"),
    session: { auth, id: sessionId },
    turn: { id: "turn-1", input: [], status: "running" },
    view,
  };
}

/**
 * Evaluates a `defineDynamic()` value. Tests mock `defineDynamic` at the eve
 * module boundary to return its function, because eve keeps the sentinel
 * opaque and exports no public evaluator.
 */
export async function evaluateDynamic<TResult, TContext>(
  definition: DynamicSentinel<TResult, TContext>,
  ctx: TContext
): Promise<TResult> {
  const resolver: object = definition;
  if (!(resolver instanceof Function)) {
    throw new TypeError(
      "Mock defineDynamic so it returns its function before evaluating it."
    );
  }
  // SAFETY: The mocked defineDynamic returns the authored resolver unchanged.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-widen-then-assert -- eve keeps the sentinel opaque and exports no evaluator.
  const evaluate = resolver as (ctx: TContext) => TResult | Promise<TResult>;
  return evaluate(ctx);
}

/**
 * Picks one tool from a resolved dynamic tool map. Eve types resolved entries
 * as `DynamicToolEntry`, so this checks the authored definition is executable.
 */
export function dynamicTool(
  resolved: DynamicToolResult,
  name: string
): ToolDefinition {
  if (!resolved || "inputSchema" in resolved) {
    throw new Error(`Expected a dynamic tool map containing ${name}.`);
  }
  const entry = resolved[name];
  if (!entry || !("execute" in entry) || !(entry.execute instanceof Function)) {
    throw new Error(`Expected the ${name} tool.`);
  }
  // SAFETY: The entry is an authored `defineTool()` value with an executor.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- eve types resolved dynamic entries without their executor.
  return entry as ToolDefinition;
}

/**
 * A `vi.mock` factory result that keeps an eve module but makes its
 * `defineDynamic` return the authored resolver, so `evaluateDynamic` can call it.
 */
export function withEvaluableDynamic<TModule extends object>(module: TModule) {
  return { ...module, defineDynamic: returnResolver };
}

function returnResolver<TResolver>(resolver: TResolver) {
  return resolver;
}
