import { braintrustEveInstrumentation } from "braintrust";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation(
  braintrustEveInstrumentation({
    recordInputs: true,
    recordOutputs: true,
  }),
);
