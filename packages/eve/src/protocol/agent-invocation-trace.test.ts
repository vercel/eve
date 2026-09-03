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
  spanId: "2".repeat(16),
  traceFlags: 1,
  traceId: "1".repeat(32),
};
const seed = {
  spanId: "4".repeat(16),
  traceFlags: 0,
  traceId: "3".repeat(32),
};

describe("agent invocation trace protocol", () => {
  it("defines the closed emitted trace contract", () => {
    expect(AGENT_TRACE_SCHEMA_VERSION).toBe(4);
    expect(AGENT_INVOCATION_ROLES).toEqual({
      caller: "caller",
      execution: "execution",
    });
    expect(AGENT_SESSION_KINDS).toEqual({
      delegated: "delegated",
      root: "root",
    });
    expect(AGENT_TRACE_ATTRIBUTES).toEqual({
      childTraceId: "agent.child.trace.id",
      invocationRole: "agent.invocation.role",
      schemaVersion: "agent.trace.schema.version",
      sessionKind: "agent.session.kind",
    });
  });

  it("serializes only parent and child coordinates", () => {
    expect(buildAgentInvocationTrace({ parent, seed })).toEqual({
      parent,
      seed,
      version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
    });
  });

  it("accepts a bounded forwarded policy without serializing decisions", () => {
    const forwardedTracePolicy = {
      ceiling: { recordInputs: false, recordOutputs: true },
      originAudience: "private" as const,
    };

    expect(buildAgentInvocationTrace({ forwardedTracePolicy, parent, seed })).toEqual({
      forwardedTracePolicy,
      parent,
      seed,
      version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
    });
  });

  it("rejects policy fields and invalid identifiers", () => {
    expect(
      agentInvocationTraceSchema.safeParse({
        parent,
        seed: { ...seed, decision: { action: "drop" } },
        version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
      }).success,
    ).toBe(false);
    expect(
      agentInvocationTraceSchema.safeParse({
        parent,
        seed: {
          spanId: "0".repeat(16),
          traceFlags: 0,
          traceId: "0".repeat(32),
        },
        version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
      }).success,
    ).toBe(false);
  });

  it("cross-validates callback, parent, and distinct child traces", () => {
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
        traceparent: parent,
      }),
    ).toBeUndefined();
    expect(
      validateAgentInvocationBinding({
        callbackCallId: "call-2",
        invocation,
        trace,
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
