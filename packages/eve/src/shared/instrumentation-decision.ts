export type InstrumentationDecision =
  | { readonly action: "drop" }
  | {
      readonly action: "record";
      readonly recordInputs: boolean;
      readonly recordOutputs: boolean;
    };

export const DROP_INSTRUMENTATION: InstrumentationDecision = { action: "drop" };
