import type {
  SessionParent,
  SessionTraceContext,
  SessionTraceCoordinates,
} from "#channel/types.js";
import type { ForwardedTraceAssertion } from "#shared/forwarded-trace-policy.js";

export const AGENT_INVOCATION_TRACE_WIRE_VERSION = 1 as const;

export type TraceCoordinates = SessionTraceCoordinates;

export type AgentInvocationTrace = {
  readonly forwardedTracePolicy?: ForwardedTraceAssertion;
  readonly parent?: TraceCoordinates;
  readonly seed: TraceCoordinates;
  readonly version: typeof AGENT_INVOCATION_TRACE_WIRE_VERSION;
};

export function buildAgentInvocationParent(input: {
  readonly callId: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnSequence: number;
}): SessionParent {
  return {
    callId: input.callId,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
    turn: { id: input.turnId, sequence: input.turnSequence },
  };
}

export function buildAgentInvocationTrace(input: {
  readonly forwardedTracePolicy?: AgentInvocationTrace["forwardedTracePolicy"];
  readonly parent?: SessionTraceContext;
  readonly seed: SessionTraceContext;
}): AgentInvocationTrace {
  const result: {
    forwardedTracePolicy?: AgentInvocationTrace["forwardedTracePolicy"];
    parent?: TraceCoordinates;
    seed: TraceCoordinates;
    version: typeof AGENT_INVOCATION_TRACE_WIRE_VERSION;
  } = {
    seed: traceCoordinates(input.seed),
    version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
  };
  if (input.forwardedTracePolicy !== undefined) {
    result.forwardedTracePolicy = input.forwardedTracePolicy;
  }
  if (input.parent !== undefined) {
    result.parent = traceCoordinates(input.parent);
  }
  return result;
}

export type AgentInvocationBindingError = "call-id-mismatch" | "trace-context-mismatch";

export function validateAgentInvocationBinding(input: {
  readonly callbackCallId?: string;
  readonly invocation?: SessionParent;
  readonly trace?: AgentInvocationTrace;
  readonly traceparent?: SessionTraceContext;
}): AgentInvocationBindingError | undefined {
  if (
    input.invocation !== undefined &&
    (input.callbackCallId === undefined || input.invocation.callId !== input.callbackCallId)
  ) {
    return "call-id-mismatch";
  }
  if (input.trace === undefined) return undefined;
  if (input.callbackCallId === undefined || input.invocation === undefined) {
    return "trace-context-mismatch";
  }
  const parent = input.trace.parent;
  if (
    (input.traceparent !== undefined &&
      (parent === undefined || !traceCoordinatesEqual(input.traceparent, parent))) ||
    (parent !== undefined && input.trace.seed.traceId === parent.traceId)
  ) {
    return "trace-context-mismatch";
  }
  return undefined;
}

export function traceCoordinatesEqual(left: TraceCoordinates, right: TraceCoordinates): boolean {
  return (
    left.traceId === right.traceId &&
    left.spanId === right.spanId &&
    left.traceFlags === right.traceFlags
  );
}

export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value) && !/^0+$/u.test(value);
}

export function isSpanId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/u.test(value) && !/^0+$/u.test(value);
}

/** Validates durable workflow metadata without pulling Zod into the workflow bundle. */
export function isTraceCoordinates(value: unknown): value is TraceCoordinates {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 3 &&
    keys.includes("spanId") &&
    keys.includes("traceFlags") &&
    keys.includes("traceId") &&
    isSpanId(Reflect.get(value, "spanId")) &&
    Number.isInteger(Reflect.get(value, "traceFlags")) &&
    Reflect.get(value, "traceFlags") >= 0 &&
    Reflect.get(value, "traceFlags") <= 255 &&
    isTraceId(Reflect.get(value, "traceId"))
  );
}

function traceCoordinates(context: SessionTraceContext): TraceCoordinates {
  return {
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    traceId: context.traceId,
  };
}
