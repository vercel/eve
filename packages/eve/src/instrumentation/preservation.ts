import { preserveSerializedInstrumentationState } from "#instrumentation/state.js";
import { preserveSerializedAgentTraceState } from "#tracing/agent-trace-context-store.js";

/** Preserves every instrumentation-owned durable slot from an interrupted worker. */
export function preserveSerializedSessionInstrumentation(
  original: Record<string, unknown>,
  interrupted: Record<string, unknown>,
): Record<string, unknown> {
  const preserved = preserveSerializedInstrumentationState(
    preserveSerializedAgentTraceState(original, interrupted),
    interrupted,
  );
  const plan = interrupted["eve.sessionInstrumentationPlan"];
  return plan === undefined ? preserved : { ...preserved, "eve.sessionInstrumentationPlan": plan };
}
