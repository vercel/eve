export type InstrumentationControls =
  | {
      readonly action: "drop";
      readonly recordInputs: false;
      readonly recordOutputs: false;
    }
  | {
      readonly action: "record";
      readonly recordInputs: boolean;
      readonly recordOutputs: boolean;
    };

export const DROP_INSTRUMENTATION: InstrumentationControls = {
  action: "drop",
  recordInputs: false,
  recordOutputs: false,
};

/** Intersects two decisions so inherited controls can only become more restrictive. */
export function intersectInstrumentationControls(
  inherited: InstrumentationControls,
  current: InstrumentationControls,
): InstrumentationControls {
  if (inherited.action === "drop" || current.action === "drop") return DROP_INSTRUMENTATION;
  return {
    action: "record",
    recordInputs: inherited.recordInputs && current.recordInputs,
    recordOutputs: inherited.recordOutputs && current.recordOutputs,
  };
}
