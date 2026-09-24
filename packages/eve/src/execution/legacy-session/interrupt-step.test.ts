import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntityConflictError } from "#compiled/@workflow/errors/index.js";
import { interruptLegacySessionStep } from "./interrupt-step.js";
import { importConversation } from "./snapshot.js";
import type { PreparedLegacySession } from "./prepare-step.js";
import { isWorkflowTaskResult } from "#tasks/state.js";
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), children: vi.fn(), settle: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun: mocks.cancel,
  getWorld: async () => ({}),
}));
vi.mock("#execution/terminate-child-sessions-step.js", () => ({
  terminateChildSessionsStep: mocks.children,
}));
vi.mock("#execution/settle-cancelled-turn-step.js", () => ({
  settleCancelledTurnStep: mocks.settle,
}));
beforeEach(() => vi.resetAllMocks());
function fixture(turnId = ""): PreparedLegacySession {
  const session = {
    sessionId: "original",
    continuationToken: "",
    history: [],
    agent: { system: "old" },
    state: {
      "eve.harness.emission": { sessionStarted: true, turnId, sequence: 4, stepIndex: 2 },
      "eve.runtime.workflowToolRuns": [
        { callId: "call", toolName: "tool", runId: "tool-run", hookToken: "tool-hook" },
      ],
    },
  };
  return {
    originalSession: session,
    sessionState: importConversation(session),
    serializedContext: {},
    sessionTimeoutMs: false,
    deploymentId: "new",
    input: {
      retention: undefined,
      mode: "conversation",
      completionToken: "old:completion",
      sessionWritable: new WritableStream(),
      serializedContext: {},
      sessionState: { sessionId: "original" },
      delivery: undefined,
      inputCommitted: false,
    },
  };
}
describe("legacy pending work", () => {
  it("cancels discoverable runs and leaves their late results without an owner", async () => {
    const prepared = fixture();
    const result = await interruptLegacySessionStep(prepared);
    expect(mocks.children).toHaveBeenCalledOnce();
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({}, "tool-run", {
      cancelReason: "Session upgraded",
    });
    expect(result.sessionState.snapshot.session.state).not.toHaveProperty(
      "eve.runtime.workflowToolRuns",
    );
    expect(
      isWorkflowTaskResult(result.sessionState.snapshot.session, {
        callId: "call",
        toolName: "tool",
      }),
    ).toBe(false);
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("discovers both pre-registry formats during conversation import", async () => {
    const prepared = fixture();
    const originalSession = {
      ...prepared.originalSession,
      state: {
        "eve.runtime.workflowToolRuns": [{ runId: "waiting-old" }],
        "eve.tasks": { version: 2, tasks: [{ taskRunId: "task-old" }] },
      },
    };
    await interruptLegacySessionStep({ ...prepared, originalSession });
    expect(mocks.cancel.mock.calls.map((call) => call[1])).toEqual(["waiting-old", "task-old"]);
  });

  it("settles an open turn once after stopping its work", async () => {
    const prepared = fixture("turn_4");
    mocks.settle.mockResolvedValue({ sessionState: prepared.sessionState, serializedContext: {} });
    await interruptLegacySessionStep(prepared);
    expect(mocks.settle).toHaveBeenCalledExactlyOnceWith({
      sessionWritable: prepared.input.sessionWritable,
      sessionState: prepared.sessionState,
      serializedContext: {},
    });
    expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.settle.mock.invocationCallOrder[0]!,
    );
  });
  it("tolerates work that finished while the import was being prepared", async () => {
    mocks.cancel.mockRejectedValue(new EntityConflictError("already finished"));
    await expect(interruptLegacySessionStep(fixture())).resolves.toBeDefined();
  });
});
