import { describe, expect, it } from "vitest";

import {
  AGENT_INVOCATION_TRACE_WIRE_VERSION,
  validateAgentInvocationBinding,
} from "#protocol/agent-invocation-trace.js";

const invocation = {
  callId: "call-1",
  rootSessionId: "root-session",
  sessionId: "parent-session",
  turn: { id: "parent-turn", sequence: 1 },
};
const parent = {
  spanId: "2".repeat(16),
  traceFlags: 1,
  traceId: "1".repeat(32),
};
const seed = {
  spanId: "4".repeat(16),
  traceFlags: 1,
  traceId: "3".repeat(32),
};

describe("validateAgentInvocationBinding", () => {
  it("accepts matching callback lineage and a distinct child trace", () => {
    expect(
      validateAgentInvocationBinding({
        callbackCallId: invocation.callId,
        invocation,
        trace: { parent, seed, version: AGENT_INVOCATION_TRACE_WIRE_VERSION },
        traceparent: parent,
      }),
    ).toBeUndefined();
  });

  it("rejects lineage bound to a different callback", () => {
    expect(
      validateAgentInvocationBinding({
        callbackCallId: "other-call",
        invocation,
      }),
    ).toBe("call-id-mismatch");
  });

  it("rejects trace coordinates without callback-bound lineage", () => {
    expect(
      validateAgentInvocationBinding({
        callbackCallId: invocation.callId,
        trace: { seed, version: AGENT_INVOCATION_TRACE_WIRE_VERSION },
      }),
    ).toBe("trace-context-mismatch");
  });

  it("rejects a child seed that reuses the parent trace", () => {
    expect(
      validateAgentInvocationBinding({
        callbackCallId: invocation.callId,
        invocation,
        trace: {
          parent,
          seed: { ...seed, traceId: parent.traceId },
          version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
        },
      }),
    ).toBe("trace-context-mismatch");
  });
});
