import { otel } from "eve/instrumentation/otel";

export default otel({
  instrumentations: ["fetch"],
  tracePolicy: ({ principalType }) => ({
    emit: true,
    recordInputs: principalType !== "metadata-only",
    recordOutputs: principalType !== "metadata-only",
  }),
});
