import { afterEach, describe, expect, it, vi } from "vitest";

import { startWorkflowToolRun, workflowTaskHookToken } from "./start.js";
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
  agents: { reviewer: { description: "Review deployments." } },
  callId: "call-1",
  input: { service: "api" },
  owner: { inbox: "owner-inbox" },
  session: {
    auth: { current: null, initiator: null },
    id: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  },
  stepIndex: 0,
  taskId: "deploy-abc234",
  toolName: "deploy",
  workflowId: "workflow//test//deploy",
};

describe("startWorkflowToolRun", () => {
  afterEach(() => vi.resetAllMocks());

  it("starts the run with a command hook derived from the owner session and task", async () => {
    const start = vi.mocked(startWorkflowOnCurrentDeployment);
    start.mockResolvedValueOnce({ runId: "run-1" } as never);

    const address = await startWorkflowToolRun(input);

    expect(address).toEqual({
      hookToken: "eve:workflow-task:session-1:deploy-abc234",
      runId: "run-1",
    });
    expect(start).toHaveBeenCalledExactlyOnceWith(workflowToolRunWorkflowReference, [
      { ...input, hookToken: address.hookToken },
    ]);
  });

  it("gives a retried start of the same task the same hook, so the duplicate run cannot claim it", async () => {
    const start = vi.mocked(startWorkflowOnCurrentDeployment);
    const failure = new Error("start response lost");
    start.mockRejectedValueOnce(failure).mockResolvedValueOnce({ runId: "retry-run" } as never);

    await expect(startWorkflowToolRun(input)).rejects.toBe(failure);
    const retried = await startWorkflowToolRun(input);
    const firstInput = start.mock.calls[0]![1][0] as WorkflowToolRunInput;

    expect(retried.runId).toBe("retry-run");
    expect(retried.hookToken).toBe(firstInput.hookToken);
    expect(workflowTaskHookToken("session-1", "deploy-abc234")).toBe(retried.hookToken);
    expect(workflowTaskHookToken("session-1", "deploy-def567")).not.toBe(retried.hookToken);
  });
});
