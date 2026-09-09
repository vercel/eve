import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWorkflowToolRun } from "#execution/workflow-tool/start.js";
import type { WorkflowToolRunInput } from "#execution/workflow-tool/types.js";

const mocks = vi.hoisted(() => ({
  attempt: 1,
  start: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getStepMetadata: () => ({ attempt: mocks.attempt }),
}));
vi.mock("#execution/workflow-start.js", () => ({ startWorkflowOnCurrentDeployment: mocks.start }));
vi.mock("#execution/inbox/readiness.js", () => ({ readStartedOwner: mocks.resolve }));

const input = { hookToken: "tool" } as WorkflowToolRunInput;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.attempt = 1;
  mocks.start.mockResolvedValue({ runId: "started" });
});

describe("workflow tool startup", () => {
  it("returns start's identity without waiting for the owner's stream", async () => {
    mocks.resolve.mockImplementation(() => new Promise(() => {}));
    expect(await startWorkflowToolRun(input)).toEqual({ hookToken: "tool", runId: "started" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.start.mock.calls[0]?.[1][0].publishOwner).toBe(false);
  });

  it("resolves a retry to the actual claim winner", async () => {
    mocks.attempt = 2;
    mocks.resolve.mockResolvedValue({ token: "tool", ownerRunId: "original" });
    expect(await startWorkflowToolRun(input)).toEqual({ hookToken: "tool", runId: "original" });
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith("started");
    expect(mocks.start.mock.calls[0]?.[1][0].publishOwner).toBe(true);
  });
});
