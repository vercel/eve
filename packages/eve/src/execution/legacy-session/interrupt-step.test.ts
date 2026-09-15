import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntityConflictError } from "#compiled/@workflow/errors/index.js";
import { interruptLegacySessionStep } from "./interrupt-step.js";
import { importConversation } from "./snapshot.js";
import type { PreparedLegacySession } from "./prepare-step.js";
import { isInboxToolResultFromRecordedWorkflowToolRun } from "#harness/workflow-tool-runs.js";
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
      "eve.runtime.workflowToolRuns": [
        { runId: "tool-run", callId: "call", toolName: "tool", hookToken: "tool-hook" },
      ],
      "eve.harness.emission": { sessionStarted: true, turnId, sequence: 4, stepIndex: 2 },
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
      parentWritable: new WritableStream(),
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
      isInboxToolResultFromRecordedWorkflowToolRun(result.sessionState.snapshot.session.state, {
        kind: "tool-result",
        callId: "call",
        toolName: "tool",
        output: "late",
      }),
    ).toBe(false);
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("settles an open turn once after stopping its work", async () => {
    const prepared = fixture("turn_4");
    mocks.settle.mockResolvedValue({ sessionState: prepared.sessionState, serializedContext: {} });
    await interruptLegacySessionStep(prepared);
    expect(mocks.settle).toHaveBeenCalledExactlyOnceWith({
      parentWritable: prepared.input.parentWritable,
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
