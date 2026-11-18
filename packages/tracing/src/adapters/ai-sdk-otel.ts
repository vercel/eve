import { OpenTelemetry } from "@ai-sdk/otel";
import {
  context,
  trace,
  createTraceState,
  INVALID_SPAN_CONTEXT,
  SpanStatusCode,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";
import type { Operation } from "../operations.js";

export function aiSdkOpenTelemetry() {
  let starting: Operation | undefined;
  let suppressNewSpans = false;
  const fallback = trace.getTracer("gen_ai");
  function startSpan(name: string, options?: SpanOptions, host?: Context): Span {
    const operation = starting;
    if (operation === undefined)
      return suppressNewSpans
        ? trace.wrapSpanContext(INVALID_SPAN_CONTEXT)
        : fallback.startSpan(name, options, host);
    const span = trace.wrapSpanContext({
      ...operation.reference,
      traceState:
        operation.reference.tracestate === undefined
          ? undefined
          : createTraceState(operation.reference.tracestate),
    });
    let failed = false;
    span.setAttributes = (attributes) => {
      operation.attributes(attributes);
      return span;
    };
    span.setAttribute = (key, value) => span.setAttributes({ [key]: value });
    span.isRecording = () =>
      !operation.finished && operation.capture.emit && (operation.reference.traceFlags & 1) !== 0;
    span.recordException = (error) => {
      failed = true;
      operation.recordError(error);
    };
    span.setStatus = (status) => {
      if (status.code === SpanStatusCode.ERROR && !failed) {
        failed = true;
        operation.recordError(undefined);
      }
      return span;
    };
    if (options?.attributes !== undefined) span.setAttributes(options.attributes);
    return span;
  }
  function startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  function startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  function startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    host: Context,
    fn: F,
  ): ReturnType<F>;
  function startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    optionsOrFn: SpanOptions | F,
    hostOrFn?: Context | F,
    callback?: F,
  ): ReturnType<F> {
    const options = typeof optionsOrFn === "function" ? undefined : optionsOrFn;
    const fn =
      typeof optionsOrFn === "function"
        ? optionsOrFn
        : typeof hostOrFn === "function"
          ? hostOrFn
          : callback!;
    const host = typeof hostOrFn === "object" ? hostOrFn : context.active();
    const span = startSpan(name, options, host);
    return context.with(trace.setSpan(host, span), () => fn(span)) as ReturnType<F>;
  }
  const tracer: Tracer = { startSpan, startActiveSpan };
  const telemetry = new OpenTelemetry({ tracer });
  return {
    telemetry,
    withoutNewSpans(execute: () => void) {
      const previous = suppressNewSpans;
      suppressNewSpans = true;
      try {
        execute();
      } finally {
        suppressNewSpans = previous;
      }
    },
    instrument(operation: Operation, execute: () => void) {
      const previous = starting;
      starting = operation;
      try {
        operation.run(execute);
      } finally {
        starting = previous;
      }
    },
  };
}
