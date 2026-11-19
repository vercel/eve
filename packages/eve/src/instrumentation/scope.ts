import type { InstrumentationScope } from "#instrumentation/lifecycle.js";

const key = Symbol.for("eve.instrumentation.trace-steps");
const global = globalThis as typeof globalThis & { [key]?: WeakMap<InstrumentationScope, number> };
const traceSteps = (global[key] ??= new WeakMap<InstrumentationScope, number>());
const turnKey = Symbol.for("eve.instrumentation.turn-scopes");
const turnGlobal = globalThis as typeof globalThis & { [turnKey]?: WeakSet<InstrumentationScope> };
const turnScopes = (turnGlobal[turnKey] ??= new WeakSet<InstrumentationScope>());

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

export function turnScope(
  input: Omit<InstrumentationScope, "rootSessionId" | "runId" | "attempt" | "turnId"> & {
    readonly rootSessionId?: string;
    readonly turnId: string;
  },
): InstrumentationScope {
  const scope = instrumentationScope({ ...input, attempt: 0, runId: input.turnId });
  turnScopes.add(scope);
  return scope;
}

export function isTurnScope(scope: InstrumentationScope): boolean {
  return turnScopes.has(scope);
}

export function copyScopeMarks(source: InstrumentationScope, copy: InstrumentationScope): void {
  const stepIndex = traceSteps.get(source);
  if (stepIndex !== undefined) traceSteps.set(copy, stepIndex);
  if (turnScopes.has(source)) turnScopes.add(copy);
}
