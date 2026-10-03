import type {
  PreparedSpan,
  SpanWriter,
  ExecutionContext,
  TraceBackend,
  TraceReference,
  CaptureDecision,
  Attributes,
  TraceErrorHandler,
} from "./types.js";
import { withoutDeclinedContent } from "./content-policy.js";
import { runTraceContext } from "./context.js";
export interface TraceOperation extends SpanWriter {
  readonly capture: CaptureDecision;
  readonly finished: boolean;
  run<T>(execute: () => T): T;
}
export function createSpanWriter(input: {
  backend: Pick<TraceBackend, "start" | "run" | "suppressed"> &
    Partial<Pick<TraceBackend, "startReserved">>;
  onError?: TraceErrorHandler;
}) {
  function safely<T>(
    execute: () => T,
    phase: "start" | "complete" = "complete",
    reference?: TraceReference,
  ): T | undefined {
    try {
      return execute();
    } catch (error) {
      try {
        input.onError?.(error, { phase, reference });
      } catch {}
      return undefined;
    }
  }
  function start(
    span: PreparedSpan,
    capture: CaptureDecision,
    host?: ExecutionContext,
    reserved?: TraceReference,
  ): TraceOperation {
    const attributes = (withoutDeclinedContent(span.attributes, capture) ??
      span.attributes) as Attributes;
    const writer = capture.emit
      ? safely(
          () =>
            reserved === undefined
              ? input.backend.start({ ...span, attributes }, host)
              : input.backend.startReserved!({ ...span, attributes }, reserved, host),
          "start",
          reserved,
        )
      : undefined;
    const reference = writer?.reference ?? {
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      traceFlags: 0,
    };
    let finished = false;
    return {
      reference,
      capture,
      get finished() {
        return finished;
      },
      setAttribute(key, value) {
        const permitted = withoutDeclinedContent({ [key]: value }, capture);
        if (!finished && (permitted === undefined || key in permitted))
          safely(() =>
            writer?.setAttribute(
              key,
              permitted === undefined ? value : (permitted[key] as typeof value),
            ),
          );
      },
      addEvent(name, attributes, timeMs) {
        if (!finished)
          safely(() =>
            writer?.addEvent(
              name,
              attributes === undefined
                ? undefined
                : ((withoutDeclinedContent(attributes, capture) ?? attributes) as Attributes),
              timeMs,
            ),
          );
      },
      fail(error, type) {
        if (!finished)
          safely(() =>
            writer?.fail(
              capture.recordOutputs ? error : undefined,
              type ?? (error instanceof Error ? error.name : undefined),
            ),
          );
      },
      setStatus(code) {
        if (!finished) safely(() => writer?.setStatus(code));
      },
      end(timeMs) {
        if (finished) return;
        finished = true;
        safely(() => writer?.end(timeMs));
      },
      run(execute) {
        return finished
          ? execute()
          : runTraceContext(input.backend, reference, capture, execute, host);
      },
    };
  }
  return {
    start,
    startReserved: (
      span: PreparedSpan,
      reference: TraceReference,
      capture: CaptureDecision,
      host?: ExecutionContext,
    ) => start(span, capture, host, reference),
  };
}
