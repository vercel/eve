import type {
  CompiledInstrumentationActivation,
  CompiledInstrumentationPlan,
} from "#compiler/manifest.js";

export type CompiledInstrumentationRuntimeMode = Exclude<
  CompiledInstrumentationActivation,
  "always"
>;

export function isCompiledInstrumentationActivationActive(
  activation: CompiledInstrumentationActivation,
  mode: CompiledInstrumentationRuntimeMode,
): boolean {
  return activation === "always" || activation === mode;
}

export function compiledInstrumentationPlanActivatesInMode(
  plan: CompiledInstrumentationPlan,
  mode: CompiledInstrumentationRuntimeMode,
): boolean {
  if (plan.kind === "none") return false;
  if (plan.kind === "file") {
    return isCompiledInstrumentationActivationActive(plan.entry.activation, mode);
  }
  return plan.entries.some((entry) =>
    isCompiledInstrumentationActivationActive(entry.activation, mode),
  );
}
