import { describe, expect, it } from "vitest";

import { mergeTaskOwnedAgentHandlesIntoTurnState } from "#harness/handles/query.js";
import { AGENT_HANDLES_STATE_KEY, type AgentHandle } from "#harness/handles/store.js";

const identity = { id: "agent-1", name: "research", nodeId: "subagents/research" };
const address = {
  continuationToken: "child-token",
  kind: "agent/local" as const,
  sessionId: "child-session",
};

describe("mergeTaskOwnedAgentHandlesIntoTurnState", () => {
  it("keeps turn-owned transitions and rebases the driver's task lease", () => {
    const parked: AgentHandle = {
      address: { ...address, sessionId: "blocking-child" },
      identity: { ...identity, id: "blocking-agent" },
      lastStatus: "done",
      phase: "parked",
    };
    const staleTask: AgentHandle = { address, identity, phase: "available" };
    const claimed: AgentHandle = {
      address,
      identity,
      operationId: "operation-1",
      phase: "claimed",
      taskId: "task-1",
    };

    const state = mergeTaskOwnedAgentHandlesIntoTurnState({
      driverState: { [AGENT_HANDLES_STATE_KEY]: { handles: [claimed] } },
      turnState: { [AGENT_HANDLES_STATE_KEY]: { handles: [parked, staleTask] }, other: true },
    });

    expect(state).toEqual({
      [AGENT_HANDLES_STATE_KEY]: { handles: [parked, claimed] },
      other: true,
    });
  });

  it("does not resurrect a task handle removed while the turn ran", () => {
    const staleTask: AgentHandle = { address, identity, phase: "available" };

    expect(
      mergeTaskOwnedAgentHandlesIntoTurnState({
        driverState: { [AGENT_HANDLES_STATE_KEY]: { handles: [] } },
        turnState: { [AGENT_HANDLES_STATE_KEY]: { handles: [staleTask] } },
      }),
    ).toEqual({ [AGENT_HANDLES_STATE_KEY]: { handles: [] } });
  });

  it("rejects a cross-owner transition for the same handle id", () => {
    const claimed: AgentHandle = {
      address,
      identity,
      operationId: "operation-1",
      phase: "claimed",
      taskId: "task-1",
    };
    const parked: AgentHandle = { address, identity, lastStatus: "done", phase: "parked" };

    expect(() =>
      mergeTaskOwnedAgentHandlesIntoTurnState({
        driverState: { [AGENT_HANDLES_STATE_KEY]: { handles: [claimed] } },
        turnState: { [AGENT_HANDLES_STATE_KEY]: { handles: [parked] } },
      }),
    ).toThrow("changed ownership");
  });
});
