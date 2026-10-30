import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { boundedTraceError } from "./serialization.js";
import { truncateTelemetryText } from "./serialization.js";
import { contentAttribute, textContentAttribute } from "./serialization.js";

/** Call with policy-projected errors; undefined retains failure status without content. */
export function recordAgentSpanError(span: Span, error: unknown, errorType?: string): void {
  span.setAttribute(
    "error.type",
    truncateTelemetryText(errorType ?? (error instanceof Error ? error.name : "_OTHER"), 128),
  );
  // A thrown Error keeps its own name; a wrapped value takes the error type.
  const wrapped = error !== undefined && !(error instanceof Error);
  if (wrapped) {
    const serialized = contentAttribute(error);
    const message =
      typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
    const detail =
      typeof error === "string"
        ? textContentAttribute(error)
        : typeof message === "string"
          ? textContentAttribute(serialized === undefined ? message : `${message}\n${serialized}`)
          : serialized;
    if (detail !== undefined) error = new Error(detail);
  }
  if (error instanceof Error) {
    const bounded = boundedTraceError(error);
    if (wrapped && errorType !== undefined) bounded.name = truncateTelemetryText(errorType, 128);
    span.recordException(bounded);
    span.setStatus({ code: SpanStatusCode.ERROR, message: bounded.message });
  } else {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}
