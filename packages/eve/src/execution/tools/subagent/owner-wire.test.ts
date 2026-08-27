import { describe, expect, it } from "vitest";

import {
  bindLegacyTurnSubagentEvent,
  bindTurnSubagentEvent,
  isTurnSubagentOutcomeBound,
} from "#execution/tools/subagent/owner-wire.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/store.js";

const from = {
  callId: "call-1",
  input: {},
  runId: "relay-run",
  stepIndex: 0,
  toolName: "research",
  turnId: "turn-1",
};
const state = {
  "eve.runtime.toolRuns": [
    {
      callId: "call-1",
      hookToken: "relay-hook",
      resultKind: "subagent",
      runId: "relay-run",
      toolName: "research",
    },
  ],
  [AGENT_HANDLES_STATE_KEY]: {
    handles: [
      {
        address: {
          continuationToken: "child-token",
          kind: "agent/local",
          sessionId: "child-session",
        },
        identity: { id: "agent-1", name: "research", nodeId: "subagents/research" },
        operation: { callId: "call-1", id: "op-1", kind: "start", parentTurnId: "turn-1" },
        phase: "running",
      },
    ],
  },
};

describe("subagent owner wire", () => {
  it("rejects an event for another child session", () => {
    const event = {
      callId: "call-1",
      childContinuationToken: "child-token",
      childSessionId: "other-child",
      event: {
        requests: [],
        sequence: 1,
        stepIndex: 0,
        turnId: "child-turn",
      },
      kind: "subagent-input-request" as const,
      subagentName: "research",
    };

    expect(bindTurnSubagentEvent(state, { event, from, kind: "subagent-event" })).toBeUndefined();
  });

  it("rejects an outcome from another relay run", () => {
    const result = {
      callId: "call-1",
      isError: true as const,
      kind: "subagent-result" as const,
      origin: "dispatch" as const,
      output: "failed",
      subagentName: "research",
    };

    expect(
      isTurnSubagentOutcomeBound(state, {
        from: { ...from, runId: "other-run" },
        kind: "subagent-outcome",
        result,
      }),
    ).toBe(false);
  });

  it("rejects a same-run envelope carrying a sibling result", () => {
    const result = {
      callId: "call-2",
      isError: true as const,
      kind: "subagent-result" as const,
      origin: "dispatch" as const,
      output: "failed",
      subagentName: "other",
    };

    expect(isTurnSubagentOutcomeBound(state, { from, kind: "subagent-outcome", result })).toBe(
      false,
    );
  });

  it("binds legacy direct events to the running child", () => {
    const event = {
      callId: "call-1",
      childContinuationToken: "child-token",
      childSessionId: "child-session",
      event: { requests: [], sequence: 1, stepIndex: 0, turnId: "child-turn" },
      kind: "subagent-input-request" as const,
      subagentName: "research",
    };

    expect(bindLegacyTurnSubagentEvent(state, event)).toBe(event);
    expect(
      bindLegacyTurnSubagentEvent(state, { ...event, childSessionId: "other-child" }),
    ).toBeUndefined();
  });
});
