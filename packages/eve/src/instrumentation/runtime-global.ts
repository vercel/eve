import type { InstrumentationRuntime } from "#instrumentation/runtime.js";

const INSTRUMENTATION_RUNTIME_KEY = Symbol.for("eve.instrumentation-runtime");

type InstrumentationGlobal = typeof globalThis & {
  [INSTRUMENTATION_RUNTIME_KEY]?: InstrumentationRuntime;
};

const globalRuntime = globalThis as InstrumentationGlobal;

/** Registers the process instrumentation runtime before agent execution begins. */
export function registerInstrumentationRuntime(
  runtime: InstrumentationRuntime,
): InstrumentationRuntime {
  const existing = globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
  if (existing !== undefined) {
    // Keep ownership stable when initialization is attempted more than once.
    existing.otelSettings = runtime.otelSettings;
    return existing;
  }
  globalRuntime[INSTRUMENTATION_RUNTIME_KEY] = runtime;
  return runtime;
}

export function getInstrumentationRuntime(): InstrumentationRuntime | undefined {
  return globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
}
