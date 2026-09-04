import { describe, expect, it, vi } from "vitest";
import type { DurableSessionState } from "#execution/session/state.js";
const mocks = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("#execution/workflow-runtime.js", () => ({
  requestWorkflowTurnCancellation: mocks.cancel,
}));
vi.mock("#execution/session/state.js", () => ({ readDurableSession: async () => ({ state: {} }) }));
vi.mock("#subagents/handles/store.js", () => ({
  getAgentHandleStore: () => ({
    handles: ["one", "two"].map((id) => ({
      phase: "claimed",
      ownerId: "owner",
      address: { kind: "agent/local", sessionId: id },
      identity: { id },
    })),
  }),
}));
import { cancelAgentInvocationOwner } from "#execution/tools/subagent/task-cancel.js";

describe("workflow-owned child cancellation", () => {
  it("awaits every child and fails before releasing handles when a cancellation fails", async () => {
    let finishSecond!: () => void;
    mocks.cancel.mockRejectedValueOnce(new Error("first child failed")).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishSecond = resolve;
      }),
    );
    const rejected = vi.fn();
    const result = cancelAgentInvocationOwner({
      ownerId: "owner",
      serializedContext: {},
      sessionState: {} as DurableSessionState,
    }).catch((error) => {
      rejected();
      return error;
    });
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    expect(rejected).not.toHaveBeenCalled();
    finishSecond();
    expect(await result).toBeInstanceOf(AggregateError);
    expect(rejected).toHaveBeenCalledOnce();
  });
});
