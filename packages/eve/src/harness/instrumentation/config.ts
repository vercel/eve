import { createInstrumentationHooks } from "#harness/instrumentation/lifecycle.js";
import { registerInstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { createInstrumentationSetupContext } from "#harness/instrumentation/setup-context.js";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";

/**
 * Process-global store for the authored instrumentation config.
 *
 * Populated at server startup by the generated Nitro instrumentation plugin
 * when the user's `agent/instrumentation.ts` has a default export produced
 * by `defineInstrumentation()`. The harness reads from this at turn time
 * to decide whether telemetry is enabled and which settings to pass to the
 * AI SDK.
 *
 * Rooted on `globalThis` so the generated Nitro instrumentation plugin
 * (which Nitro keeps external by `file://` URL) and the bundled harness
 * chunk (which Nitro inlines via the package's `#harness/*` import alias)
 * share one source of truth, even though they resolve to two distinct ESM
 * module instances. See `context/key.ts` and
 * `runtime/sessions/runtime-session.ts` for the established pattern.
 */
const INSTRUMENTATION_CONFIG_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-config");

interface InstrumentationConfigGlobal {
  [INSTRUMENTATION_CONFIG_GLOBAL_KEY]?: InstrumentationDefinition;
}

const globalContainer = globalThis as typeof globalThis & InstrumentationConfigGlobal;

/**
 * Registers the authored instrumentation config and awaits its `setup`
 * callback.
 *
 * Called once by the generated instrumentation Nitro plugin at server
 * startup. Subsequent calls overwrite the previous value.
 *
 * The store write lands before `setup` runs so a synchronous caller sees the
 * config without waiting on the returned promise.
 *
 * @internal — not part of the public API.
 */
export async function registerInstrumentationConfig(
  config: InstrumentationDefinition,
  input: { readonly agentName: string },
): Promise<void> {
  globalContainer[INSTRUMENTATION_CONFIG_GLOBAL_KEY] = config;
  // This legacy layout leaves `registerOTel` to `setup`, so install only the
  // runtime projection consumed by the harness.
  registerInstrumentationRuntime({
    forceFlush: async () => undefined,
    hooks: createInstrumentationHooks([]),
    otelSettings: {
      functionId: config.functionId,
      recordInputs: config.recordInputs === true,
      recordOutputs: config.recordOutputs === true,
      traceChannelRequests: config.traceChannelRequests === true,
    },
    resolveControls: () => ({
      action: "record",
      recordInputs: config.recordInputs === true,
      recordOutputs: config.recordOutputs === true,
    }),
    runInContext: (_operation, execute) => execute(),
    runWithTracingSuppressed: (execute) => execute(),
    shutdown: async () => undefined,
  });
  await config.setup?.(createInstrumentationSetupContext(input.agentName));
}

/**
 * Returns the registered instrumentation config, or `undefined` when no
 * `defineInstrumentation` export was provided.
 *
 * @internal — not part of the public API.
 */
export function getInstrumentationConfig(): InstrumentationDefinition | undefined {
  return globalContainer[INSTRUMENTATION_CONFIG_GLOBAL_KEY];
}
