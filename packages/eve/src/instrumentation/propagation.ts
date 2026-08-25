import type { InstrumentationTraceContext } from "#instrumentation/lifecycle.js";
import {
  parseSessionInstrumentationPlan,
  type SerializedSessionInstrumentation,
} from "#instrumentation/session-plan.js";
import {
  readActionTraceContext,
  readSessionTraceContext,
} from "#tracing/agent-trace-context-store.js";

/** Returns portable session propagation without exposing provider state to execution. */
export function readSessionInstrumentationTraceContext(
  serializedContext: Readonly<Record<string, unknown>>,
  sessionId: string,
): InstrumentationTraceContext | undefined {
  const plan = readPlan(serializedContext);
  if (plan !== undefined) {
    const data = parseSessionInstrumentationPlan(plan);
    if (data !== undefined && data.traceId.length > 0) {
      return { spanId: data.spanId, traceFlags: data.traceFlags, traceId: data.traceId };
    }
  }
  return portable(readSessionTraceContext(serializedContext, sessionId));
}

/** Returns action propagation, falling back to the frozen session context. */
export function readChildInstrumentationTraceContext(input: {
  readonly callId: string;
  readonly serializedContext: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  readonly turnId: string;
}): InstrumentationTraceContext | undefined {
  return (
    portable(
      readActionTraceContext(input.serializedContext, input.sessionId, input.turnId, input.callId),
    ) ?? readSessionInstrumentationTraceContext(input.serializedContext, input.sessionId)
  );
}

function readPlan(
  serializedContext: Readonly<Record<string, unknown>>,
): SerializedSessionInstrumentation | undefined {
  const value = serializedContext["eve.sessionInstrumentationPlan"];
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== 1 || typeof record["data"] !== "object") return undefined;
  return value as SerializedSessionInstrumentation;
}

function portable(
  context:
    | {
        readonly spanId: string;
        readonly traceFlags: number;
        readonly traceId: string;
      }
    | undefined,
): InstrumentationTraceContext | undefined {
  if (context === undefined) return undefined;
  return {
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    traceId: context.traceId,
  };
}
