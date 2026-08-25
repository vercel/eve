import { preserveSerializedInstrumentationState } from "#instrumentation/state.js";
import { preserveSerializedAgentTraceState } from "#tracing/agent-trace-context-store.js";

/** Preserves every instrumentation-owned durable slot from an interrupted worker. */
export function preserveSerializedSessionInstrumentation(
  original: Record<string, unknown>,
  interrupted: Record<string, unknown>,
): Record<string, unknown> {
  return preserveSerializedInstrumentationState(
    preserveSerializedAgentTraceState(original, interrupted),
    interrupted,
  );
}
