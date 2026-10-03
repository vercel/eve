import type {
  ActiveOperation,
  CaptureDecision,
  ExecutionContext,
  TraceBackend,
  TraceReference,
} from "./types.js";

export function runTraceContext<T>(
  backend: Pick<TraceBackend, "run" | "suppressed">,
  reference: TraceReference,
  capture: CaptureDecision,
  execute: () => T,
  host?: ExecutionContext,
  operation?: ActiveOperation,
): T {
  let entered = false;
  try {
    return backend.run(
      reference,
      capture,
      () => {
        entered = true;
        return execute();
      },
      host,
      operation,
    );
  } catch (error) {
    if (entered) throw error;
    if (backend.suppressed !== undefined) {
      try {
        return backend.suppressed(() => {
          entered = true;
          return execute();
        });
      } catch (error) {
        if (entered) throw error;
      }
    }
    return execute();
  }
}
