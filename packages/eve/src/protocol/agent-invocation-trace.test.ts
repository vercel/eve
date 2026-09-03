import { describe, expect, it } from "vitest";

import {
  AGENT_INVOCATION_ROLES,
  AGENT_INVOCATION_TRACE_WIRE_VERSION,
  AGENT_SESSION_KINDS,
  AGENT_TRACE_ATTRIBUTES,
  AGENT_TRACE_SCHEMA_VERSION,
  agentInvocationTraceSchema,
  buildAgentInvocationTrace,
  validateAgentInvocationBinding,
} from "#protocol/agent-invocation-trace.js";

const parent = {
  decision: { action: "record", recordInputs: true, recordOutputs: false } as const,
  spanId: "2".repeat(16),
  traceFlags: 1,
  traceId: "1".repeat(32),
};
const seed = {
  decision: { action: "drop" } as const,
  forwardedTracePolicy: {
    ceiling: { recordInputs: false, recordOutputs: false },
    originAudience: "unknown" as const,
  },
  spanId: "4".repeat(16),
  traceFlags: 0,
  traceId: "3".repeat(32),
};

describe("agent invocation trace protocol", () => {
  it("defines the closed emitted trace contract", () => {
    expect(AGENT_TRACE_SCHEMA_VERSION).toBe(4);
    expect(AGENT_INVOCATION_ROLES).toEqual({ caller: "caller", execution: "execution" });
    expect(AGENT_SESSION_KINDS).toEqual({ delegated: "delegated", root: "root" });
    expect(AGENT_TRACE_ATTRIBUTES).toMatchObject({
      invocationRole: "agent.invocation.role",
      principalCurrentType: "agent.principal.current.type",
      principalInitiatorType: "agent.principal.initiator.type",
      schemaVersion: "agent.trace.schema.version",
      sessionKind: "agent.session.kind",
    });
  });

  it("serializes only parent and child coordinates", () => {
    expect(buildAgentInvocationTrace({ parent, seed })).toEqual({
      parent: {
        spanId: parent.spanId,
        traceFlags: parent.traceFlags,
        traceId: parent.traceId,
      },
      seed: {
        spanId: seed.spanId,
        traceFlags: seed.traceFlags,
        traceId: seed.traceId,
      },
      version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
    });
  });

  it("rejects policy fields and invalid identifiers on a child seed", () => {
    expect(
      agentInvocationTraceSchema.safeParse({
        parent,
        seed,
        version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
      }).success,
    ).toBe(false);
    expect(
      agentInvocationTraceSchema.safeParse({
        parent,
        seed: { spanId: "0".repeat(16), traceFlags: 0, traceId: "0".repeat(32) },
        version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
      }).success,
    ).toBe(false);
  });

  it("cross-validates callback, parent header, and distinct child trace identity", () => {
    const invocation = {
      callId: "call-1",
      rootSessionId: "root-session",
      sessionId: "parent-session",
      turn: { id: "parent-turn", sequence: 0 },
    };
    const trace = buildAgentInvocationTrace({ parent, seed });
    expect(
      validateAgentInvocationBinding({
        callbackCallId: "call-1",
        invocation,
        trace,
      }),
    ).toBeUndefined();
    expect(
      validateAgentInvocationBinding({
        callbackCallId: "call-1",
        invocation,
        trace,
        traceparent: parent,
      }),
    ).toBeUndefined();
    expect(
      validateAgentInvocationBinding({
        callbackCallId: "call-2",
        invocation,
        trace,
        traceparent: parent,
      }),
    ).toBe("call-id-mismatch");
    expect(
      validateAgentInvocationBinding({
        callbackCallId: "call-1",
        invocation,
        trace: { ...trace, seed: { ...trace.seed, traceId: parent.traceId } },
        traceparent: parent,
      }),
    ).toBe("trace-context-mismatch");
  });
});
