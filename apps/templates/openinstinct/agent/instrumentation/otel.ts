import { otel } from "eve/instrumentation/otel";

export default otel({
  traceChannelRequests: true,
  tracePolicy: ({ environment }) => ({
    emit: true,
    recordInputs: environment === "development",
    recordOutputs: environment === "development",
  }),
});
