import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import { registerInstrumentationRuntime } from "#instrumentation/runtime.js";
import { createInstrumentationSetupContext } from "#instrumentation/setup-context.js";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";

const INSTRUMENTATION_CONFIG_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-config");

interface InstrumentationConfigGlobal {
  [INSTRUMENTATION_CONFIG_GLOBAL_KEY]?: InstrumentationDefinition;
}

const globalContainer = globalThis as typeof globalThis & InstrumentationConfigGlobal;

/** Registers legacy defineInstrumentation() through the shared runtime path. */
export async function registerInstrumentationConfig(
  config: InstrumentationDefinition,
  input: { readonly agentName: string },
): Promise<void> {
  globalContainer[INSTRUMENTATION_CONFIG_GLOBAL_KEY] = config;
  registerInstrumentationRuntime({
    forceFlush: async () => undefined,
    hooks: createInstrumentationHooks([]),
    otelSettings: {
      functionId: config.functionId,
      recordInputs: config.recordInputs === true,
      recordOutputs: config.recordOutputs === true,
      traceChannelRequests: config.traceChannelRequests === true,
    },
    runInContext: (_operation, execute) => execute(),
    shutdown: async () => undefined,
  });
  await config.setup?.(createInstrumentationSetupContext(input.agentName));
}

/** Returns the registered legacy definition for AI SDK runtime-context adaptation. */
export function getInstrumentationConfig(): InstrumentationDefinition | undefined {
  return globalContainer[INSTRUMENTATION_CONFIG_GLOBAL_KEY];
}
