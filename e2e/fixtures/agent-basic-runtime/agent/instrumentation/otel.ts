import { otel } from "eve/instrumentation/otel";

export default otel({
  instrumentations: ["fetch"],
  tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
});
