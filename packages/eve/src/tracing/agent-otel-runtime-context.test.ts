import { describe, expect, it } from "vitest";

import { agentActivationAttributes } from "#tracing/agent-otel-runtime-context.js";
import type { AgentSessionTraceState, AgentTurnTraceState } from "#tracing/agent-trace-state.js";

const context = {
  spanId: "1".repeat(16),
  traceFlags: 1,
  traceId: "2".repeat(32),
};

function turn(overrides: Partial<AgentTurnTraceState> = {}): AgentTurnTraceState {
  return {
    context,
    rootSessionId: "root-session",
    sequence: 0,
    startTimeMs: 1,
    ...overrides,
  };
}

function session(overrides: Partial<AgentSessionTraceState> = {}): AgentSessionTraceState {
  return {
    agentName: "general",
    channelAudience: "public",
    channelKind: "slack",
    context,
    decision: { action: "record", recordInputs: true, recordOutputs: true },
    rootSessionId: "root-session",
    title: "Call the general agent",
    ...overrides,
  };
}

describe("agentActivationAttributes", () => {
  it("emits root-session inventory and trace-policy metadata", () => {
    expect(
      agentActivationAttributes({
        agentName: "general",
        frameworkVersion: "test",
        session: session(),
        sessionId: "root-session",
        turn: turn(),
        turnId: "turn_0",
      }),
    ).toMatchObject({
      "agent.channel.audience": "public",
      "agent.run.type": "session",
      "agent.session.origin": "channel",
      "agent.session.title": "Call the general agent",
      "agent.trace.content.input": true,
      "agent.trace.content.output": true,
    });
  });

  it("emits delegated schedule provenance without disclosing a hidden title", () => {
    const attributes = agentActivationAttributes({
      agentName: "general",
      frameworkVersion: "test",
      session: session({
        channelAudience: "private",
        decision: { action: "record", recordInputs: false, recordOutputs: true },
        scheduleId: "daily-report",
      }),
      sessionId: "child-session",
      turn: turn({
        parentLineage: {
          callId: "call-1",
          sessionId: "parent-session",
          subagentName: "general",
          turnId: "turn_0",
        },
      }),
      turnId: "turn_0",
    });

    expect(attributes).toMatchObject({
      "agent.channel.audience": "private",
      "agent.run.type": "subagent",
      "agent.schedule.id": "daily-report",
      "agent.session.origin": "schedule",
      "agent.trace.content.input": false,
      "agent.trace.content.output": true,
    });
    expect(attributes["agent.session.title"]).toBeUndefined();
  });
});
