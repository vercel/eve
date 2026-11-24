import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import { processApp } from "#runtime/app.js";

export function registerInstrumentationRuntime(
  runtime: InstrumentationRuntime,
): InstrumentationRuntime {
  const instrumentation = processApp().instrumentation;
  if (instrumentation.runtime !== undefined) {
    instrumentation.runtime.otelSettings = runtime.otelSettings;
    return instrumentation.runtime;
  }
  instrumentation.runtime = runtime;
  return runtime;
}

export function getInstrumentationRuntime(): InstrumentationRuntime | undefined {
  return processApp().instrumentation.runtime;
}
