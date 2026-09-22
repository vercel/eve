import { truncateTelemetryText } from "#tracing/telemetry-budget.js";

export function boundedTraceError(value: Error): Error {
  const error = new Error(truncateTelemetryText(value.message, 4096));
  error.name = truncateTelemetryText(value.name, 128);
  error.stack = value.stack === undefined ? undefined : truncateTelemetryText(value.stack, 8192);
  return error;
}
