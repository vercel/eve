import type { ActiveOperation, AgentTelemetry, ExecutionContext } from "./types.js";

/** Runs `execute` exactly once, even when the telemetry cannot enter the context. */
export function runTraceContext<T>(
  telemetry: Pick<AgentTelemetry, "run" | "suppressed">,
  operation: ActiveOperation,
  execute: () => T,
  host?: ExecutionContext,
): T {
  let entered = false;
  try {
    return telemetry.run(
      operation,
      () => {
        entered = true;
        return execute();
      },
      host,
    );
  } catch (error) {
    if (entered) throw error;
    if (telemetry.suppressed !== undefined) {
      try {
        return telemetry.suppressed(() => {
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
