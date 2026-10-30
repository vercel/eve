import type { InstrumentationScope } from "#instrumentation/lifecycle.js";

const key = Symbol.for("eve.instrumentation.trace-steps");
const global = globalThis as typeof globalThis & { [key]?: WeakMap<InstrumentationScope, number> };
const traceSteps = (global[key] ??= new WeakMap<InstrumentationScope, number>());

/** Public scopes name runs; schema-4 traces retain their per-turn step numbering privately. */
export function instrumentationScope(
  input: Omit<InstrumentationScope, "rootSessionId"> & { readonly rootSessionId?: string },
  stepIndex?: number,
): InstrumentationScope {
  const scope = (
    input.rootSessionId === undefined ? { ...input, rootSessionId: input.sessionId } : input
  ) as InstrumentationScope;
  if (stepIndex !== undefined) traceSteps.set(scope, stepIndex);
  return scope;
}

export function traceStepIndex(scope: InstrumentationScope): number | undefined {
  return traceSteps.get(scope);
}
