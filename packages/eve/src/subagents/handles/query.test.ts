import { describe, expect, it } from "vitest";

import { mergeTaskOwnedAgentHandlesIntoTurnState } from "#subagents/handles/query.js";
import { AGENT_HANDLES_STATE_KEY, type AgentHandle } from "#subagents/handles/store.js";

const address = {
  continuationToken: "child-token",
  kind: "agent/local" as const,
  sessionId: "child-session",
};
const identity = { id: "agent-1", name: "research", nodeId: "subagents/research" };
const available: AgentHandle = { address, identity, phase: "available" };
const claimed: AgentHandle = {
  address,
  callId: "call-1",
  identity,
  operationId: "operation-1",
  ownerId: "workflow-run-1",
  phase: "claimed",
};

describe("mergeTaskOwnedAgentHandlesIntoTurnState", () => {
  it("preserves a blocking workflow run's claim when the driver did not change the handle", () => {
    const baseState = {
      [AGENT_HANDLES_STATE_KEY]: {
        handles: [{ phase: "available", identity: { ...identity }, address: { ...address } }],
      },
    };

    expect(
      mergeTaskOwnedAgentHandlesIntoTurnState({
        baseState,
        driverState: baseState,
        turnState: { [AGENT_HANDLES_STATE_KEY]: { handles: [claimed] } },
      }),
    ).toEqual({ [AGENT_HANDLES_STATE_KEY]: { handles: [claimed] } });
  });

  it("rejects conflicting owner mutations from the driver and turn", () => {
    const taskClaim: AgentHandle = { ...claimed, ownerId: "task_1" };

    expect(() =>
      mergeTaskOwnedAgentHandlesIntoTurnState({
        baseState: { [AGENT_HANDLES_STATE_KEY]: { handles: [available] } },
        driverState: { [AGENT_HANDLES_STATE_KEY]: { handles: [taskClaim] } },
        turnState: { [AGENT_HANDLES_STATE_KEY]: { handles: [claimed] } },
      }),
    ).toThrow("changed ownership while its turn was running");
  });
});
