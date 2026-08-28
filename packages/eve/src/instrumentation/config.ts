import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import { registerInstrumentationRuntime } from "#instrumentation/runtime.js";
import { createInstrumentationSetupContext } from "#instrumentation/setup-context.js";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";

/**
 * Registers the authored instrumentation config and awaits its `setup`
 * callback.
 *
 * Called once by the generated instrumentation Nitro plugin at server
 * startup. Subsequent calls overwrite the previous value.
 *
 * @internal — not part of the public API.
 */
export async function registerInstrumentationConfig(
  config: InstrumentationDefinition,
  input: { readonly agentName: string },
): Promise<void> {
  // This legacy layout leaves `registerOTel` to `setup`, so install only the
  // runtime projection consumed by the harness.
  const runtime = registerInstrumentationRuntime({
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
  runtime.stepStartedRuntimeContextResolver = (event) => config.events?.["step.started"]?.(event);
  await config.setup?.(createInstrumentationSetupContext(input.agentName));
}
