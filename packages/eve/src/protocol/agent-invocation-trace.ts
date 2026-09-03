import { z } from "#compiled/zod/index.js";

import type { SessionParent, SessionTraceContext } from "#channel/types.js";

export const AGENT_TRACE_SCHEMA_VERSION = 4 as const;
export const AGENT_INVOCATION_TRACE_WIRE_VERSION = 1 as const;
export const AGENT_INVOCATION_ROLES = {
  caller: "caller",
  execution: "execution",
} as const;
export const AGENT_SESSION_KINDS = {
  delegated: "delegated",
  root: "root",
} as const;
export const AGENT_TRACE_ATTRIBUTES = {
  childTraceId: "agent.child.trace.id",
  invocationRole: "agent.invocation.role",
  schemaVersion: "agent.trace.schema.version",
  sessionKind: "agent.session.kind",
} as const;

export const traceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/u)
  .refine((value) => !/^0+$/u.test(value));
export const spanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/u)
  .refine((value) => !/^0+$/u.test(value));
export const forwardedTracePolicySchema = z.strictObject({
  ceiling: z.strictObject({ recordInputs: z.boolean(), recordOutputs: z.boolean() }),
  originAudience: z.enum(["private", "public", "unknown"]),
});

export const traceCoordinatesSchema = z.strictObject({
  spanId: spanIdSchema,
  traceFlags: z.number().int().min(0).max(255),
  traceId: traceIdSchema,
});

export const sessionParentSchema: z.ZodType<SessionParent> = z.strictObject({
  callId: z.string().min(1),
  rootSessionId: z.string().min(1),
  sessionId: z.string().min(1),
  turn: z.strictObject({ id: z.string().min(1), sequence: z.number().int().min(0) }),
});

export const agentInvocationTraceSchema = z.strictObject({
  forwardedTracePolicy: forwardedTracePolicySchema.optional(),
  parent: traceCoordinatesSchema.optional(),
  seed: traceCoordinatesSchema,
  version: z.literal(AGENT_INVOCATION_TRACE_WIRE_VERSION),
});

export type AgentInvocationTrace = z.infer<typeof agentInvocationTraceSchema>;
export type TraceCoordinates = z.infer<typeof traceCoordinatesSchema>;

export const createSessionAcceptedResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  status: z.literal("accepted"),
  trace: traceCoordinatesSchema.optional(),
});

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
  const result: AgentInvocationTrace = {
    seed: traceCoordinates(input.seed),
    version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
  };
  if (input.forwardedTracePolicy !== undefined) {
    result.forwardedTracePolicy = input.forwardedTracePolicy;
  }
  if (input.parent !== undefined) result.parent = traceCoordinates(input.parent);
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

function traceCoordinates(context: SessionTraceContext): TraceCoordinates {
  return {
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    traceId: context.traceId,
  };
}
