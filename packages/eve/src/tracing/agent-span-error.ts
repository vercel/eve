import { SpanStatusCode, type Span } from "#compiled/@opentelemetry/api/index.js";
import { boundedTraceError } from "#tracing/bounded-error.js";
import { truncateTelemetryText } from "#tracing/telemetry-budget.js";

/** Call with policy-projected errors; undefined retains failure status without content. */
export function recordAgentSpanError(span: Span, error: unknown, errorType?: string): void {
  span.setAttribute(
    "error.type",
    truncateTelemetryText(
      errorType ?? (error instanceof Error ? error.name || "Error" : "_OTHER"),
      128,
    ),
  );
  if (error instanceof Error) {
    const bounded = boundedTraceError(error);
    span.recordException(bounded);
    span.setStatus({ code: SpanStatusCode.ERROR, message: bounded.message });
  } else {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}
