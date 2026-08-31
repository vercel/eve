export type InstrumentationDecision =
  | { readonly action: "drop" }
  | {
      readonly action: "record";
      readonly recordInputs: boolean;
      readonly recordOutputs: boolean;
    };

export const DROP_INSTRUMENTATION: InstrumentationDecision = { action: "drop" };

/** Reads durable decision state, treating malformed persisted values as drop. */
export function readInstrumentationDecision(value: unknown): InstrumentationDecision | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DROP_INSTRUMENTATION;
  }
  const decision = value as Partial<InstrumentationDecision>;
  if (decision.action === "drop") return DROP_INSTRUMENTATION;
  return decision.action === "record" &&
    typeof decision.recordInputs === "boolean" &&
    typeof decision.recordOutputs === "boolean"
    ? {
        action: "record",
        recordInputs: decision.recordInputs,
        recordOutputs: decision.recordOutputs,
      }
    : DROP_INSTRUMENTATION;
}

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
