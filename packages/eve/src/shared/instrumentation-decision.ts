export type InstrumentationDecision =
  | { readonly action: "drop" }
  | {
      readonly action: "record";
      readonly recordInputs: boolean;
      readonly recordOutputs: boolean;
    };

export const DROP_INSTRUMENTATION: InstrumentationDecision = { action: "drop" };

export function intersectInstrumentationDecisions(
  left: InstrumentationDecision,
  right: InstrumentationDecision,
): InstrumentationDecision {
  if (left.action === "drop" || right.action === "drop") return DROP_INSTRUMENTATION;
  return {
    action: "record",
    recordInputs: left.recordInputs && right.recordInputs,
    recordOutputs: left.recordOutputs && right.recordOutputs,
  };
}
