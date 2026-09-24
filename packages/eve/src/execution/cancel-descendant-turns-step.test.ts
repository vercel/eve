import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import type { HarnessSession } from "#harness/types.js";

vi.mock("#execution/tools/workflow/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("cancelDescendantTurnsStep", () => {
  it("cancels every workflow tool run the active turn is waiting on", async () => {
    await cancelDescendantTurnsStep({
      sessionState: createDurableSessionState({
        session: createSession({
          "eve.harness.emission": {
            sequence: 0,
            sessionStarted: true,
            stepIndex: 0,
            turnId: "turn_1",
          },
          "eve.workflowTool": {
            runs: [
              createRun({ callId: "call-a", runId: "run-a", turnId: "turn_1" }),
              createRun({ callId: "call-b", runId: "run-b", turnId: "turn_1" }),
              createRun({ callId: "call-old", runId: "run-old", turnId: "turn_0" }),
            ],
            version: 3,
          },
        }),
      }),
    });

    expect(cancelWorkflowToolRun).toHaveBeenCalledTimes(2);
    expect(cancelWorkflowToolRun).toHaveBeenCalledWith(
      { hookToken: "hook-run-a", runId: "run-a" },
      "The turn that called the tool was cancelled.",
    );
    expect(cancelWorkflowToolRun).toHaveBeenCalledWith(
      { hookToken: "hook-run-b", runId: "run-b" },
      "The turn that called the tool was cancelled.",
    );
  });

  it("does nothing when the turn has no workflow tool runs", async () => {
    await cancelDescendantTurnsStep({
      sessionState: createDurableSessionState({ session: createSession() }),
    });

    expect(cancelWorkflowToolRun).not.toHaveBeenCalled();
  });
});

function createRun(input: {
  readonly callId: string;
  readonly runId: string;
  readonly turnId: string;
}) {
  return {
    address: { hookToken: `hook-${input.runId}`, runId: input.runId },
    callId: input.callId,
    lifetime: "turn",
    origin: { stepIndex: 0, turnId: input.turnId },
    toolName: "research",
  };
}

function createSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:parent",
    history: [],
    sessionId: "parent",
    state,
  };
}
