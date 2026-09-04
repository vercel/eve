import { z } from "#compiled/zod/index.js";

import type { SessionParent } from "#channel/types.js";
import {
  AGENT_INVOCATION_TRACE_WIRE_VERSION,
  isSpanId,
  isTraceId,
  type AgentInvocationTrace,
  type TraceCoordinates,
} from "#protocol/agent-invocation-trace.js";

export const traceIdSchema = z.string().refine(isTraceId);
export const spanIdSchema = z.string().refine(isSpanId);
export const forwardedTracePolicySchema = z.strictObject({
  ceiling: z.strictObject({ recordInputs: z.boolean(), recordOutputs: z.boolean() }),
  originAudience: z.enum(["private", "public", "unknown"]),
});

export const traceCoordinatesSchema: z.ZodType<TraceCoordinates> = z.strictObject({
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

export const agentInvocationTraceSchema: z.ZodType<AgentInvocationTrace> = z.strictObject({
  forwardedTracePolicy: forwardedTracePolicySchema.optional(),
  parent: traceCoordinatesSchema.optional(),
  seed: traceCoordinatesSchema,
  version: z.literal(AGENT_INVOCATION_TRACE_WIRE_VERSION),
});

export const createSessionAcceptedResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  status: z.literal("accepted"),
  trace: traceCoordinatesSchema.optional(),
});
