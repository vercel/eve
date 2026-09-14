import { afterEach, describe, expect, it, vi } from "vitest";

import { startWorkflowToolRun } from "./start.js";
import type { WorkflowToolRunInput } from "./types.js";
import {
  startWorkflowOnCurrentDeployment,
  workflowToolRunWorkflowReference,
} from "#execution/workflow-runtime.js";

vi.mock("#execution/workflow-runtime.js", () => ({
  startWorkflowOnCurrentDeployment: vi.fn(),
  workflowToolRunWorkflowReference: { workflowId: "workflow//eve//workflowToolRunWorkflow" },
}));

const input: Omit<WorkflowToolRunInput, "hookToken"> = {
  callId: "call-1",
  input: { service: "api" },
  owner: { inbox: "owner-inbox" },
  session: {
    auth: { current: null, initiator: null },
    id: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  },
  stepIndex: 0,
  toolName: "deploy",
  workflowId: "workflow//test//deploy",
};

describe("startWorkflowToolRun", () => {
  afterEach(() => vi.resetAllMocks());

  it("starts repeated calls independently and returns each run's cancellation address", async () => {
    const start = vi.mocked(startWorkflowOnCurrentDeployment);
    start
      .mockResolvedValueOnce({ runId: "run-1" } as never)
      .mockResolvedValueOnce({ runId: "run-2" } as never);

    const first = await startWorkflowToolRun(input);
    const second = await startWorkflowToolRun(input);

    expect(first.runId).toBe("run-1");
    expect(second.runId).toBe("run-2");
    expect(first.hookToken).toBeTruthy();
    expect(second.hookToken).not.toBe(first.hookToken);
    for (const [index, address] of [first, second].entries()) {
      expect(start).toHaveBeenNthCalledWith(index + 1, workflowToolRunWorkflowReference, [
        { ...input, hookToken: address.hookToken },
      ]);
    }
  });

  it("uses a new token after an ambiguous start failure", async () => {
    const start = vi.mocked(startWorkflowOnCurrentDeployment);
    const failure = new Error("start response lost");
    start.mockRejectedValueOnce(failure).mockResolvedValueOnce({ runId: "retry-run" } as never);

    await expect(startWorkflowToolRun(input)).rejects.toBe(failure);
    const retried = await startWorkflowToolRun(input);
    const firstInput = start.mock.calls[0]![1][0] as WorkflowToolRunInput;

    expect(retried.runId).toBe("retry-run");
    expect(retried.hookToken).not.toBe(firstInput.hookToken);
  });
});
