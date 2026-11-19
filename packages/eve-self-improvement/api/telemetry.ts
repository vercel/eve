import { otel } from "eve/instrumentation/otel";

/** Exports OTel spans without recording model inputs or outputs; mount this policy in the host instrumentation. */
export const privateTelemetry = otel({
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
});
export { observe, pseudonym } from "../extension/lib/observe.js";
