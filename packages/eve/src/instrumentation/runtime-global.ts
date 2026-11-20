import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import { eveRuntime } from "#runtime/eve-runtime.js";

export function registerInstrumentationRuntime(
  runtime: InstrumentationRuntime,
): InstrumentationRuntime {
  const instrumentation = eveRuntime().instrumentation;
  if (instrumentation.runtime !== undefined) {
    instrumentation.runtime.otelSettings = runtime.otelSettings;
    return instrumentation.runtime;
  }
  instrumentation.runtime = runtime;
  return runtime;
}

export function getInstrumentationRuntime(): InstrumentationRuntime | undefined {
  return eveRuntime().instrumentation.runtime;
}
