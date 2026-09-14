import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import type { FinalizedNodeSourceState } from "#compiler/node-source-state.js";

export function assertInstrumentationLayoutConfig(
  config: CompiledAgentDefinition,
  state: FinalizedNodeSourceState,
): void {
  if (
    config.experimental?.instrumentationProviders === true &&
    state.composed.selected.has("instrumentation")
  ) {
    throw new Error(
      "A selected instrumentation.ts source cannot be used with experimental.instrumentationProviders. Move the declaration into the instrumentation/ provider directory.",
    );
  }
}
