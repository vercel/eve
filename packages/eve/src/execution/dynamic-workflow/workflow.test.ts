import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeAgent: vi.fn(),
  runDynamicWorkflowProgramStep: vi.fn(),
}));

vi.mock("#execution/tools/subagent/invoke-agent.js", () => ({ invokeAgent: mocks.invokeAgent }));
vi.mock("#execution/dynamic-workflow/program-step.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runDynamicWorkflowProgramStep: mocks.runDynamicWorkflowProgramStep,
}));

import { serializeDynamicWorkflowInput } from "#execution/dynamic-workflow/schema.js";
import { dynamicWorkflow, readAgentInput } from "#execution/dynamic-workflow/workflow.js";

const input = serializeDynamicWorkflowInput({
  agents: [
    {
      description: "Research.",
      inputSchema: { type: "object" },
      name: "researcher",
      outputSchema: null,
    },
  ],
  continuationSecurity: { signingKey: "key" },
  js: "return 1",
  maxSubagents: 2,
});
const pending = {
  payload: {
    kind: "eve.dynamic-workflow-call",
    toolInput: { message: "one" },
    toolName: "researcher",
  },
} as never;
const ctx = {
  abortSignal: new AbortController().signal,
  callId: "workflow-call",
} as never;

describe("dynamicWorkflow", () => {
  beforeEach(() => vi.resetAllMocks());

  it("delegates interrupts and resumes the sandbox", async () => {
    mocks.runDynamicWorkflowProgramStep
      .mockResolvedValueOnce({ interrupt: pending, pending: [pending], status: "interrupted" })
      .mockResolvedValueOnce({ output: { result: "done" }, status: "completed" });
    mocks.invokeAgent.mockResolvedValue({ result: "child" });

    await expect(dynamicWorkflow(input, ctx)).resolves.toEqual({ result: "done" });
    expect(mocks.invokeAgent).toHaveBeenCalledWith(
      ctx,
      { message: "one", target: "researcher" },
      { invocationId: "workflow-call:0" },
    );
    expect(mocks.runDynamicWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: {
          interrupt: pending,
          resolutions: [{ status: "completed", output: { result: "child" } }],
        },
      }),
    );
  });

  it("returns a failed resolution for calls over the subagent budget", async () => {
    mocks.runDynamicWorkflowProgramStep
      .mockResolvedValueOnce({
        interrupt: pending,
        pending: [pending, pending, pending],
        status: "interrupted",
      })
      .mockResolvedValueOnce({ output: ["one", "two", "limited"], status: "completed" });
    mocks.invokeAgent.mockResolvedValueOnce("one").mockResolvedValueOnce("two");

    await expect(dynamicWorkflow(input, ctx)).resolves.toEqual(["one", "two", "limited"]);
    expect(mocks.invokeAgent).toHaveBeenCalledTimes(2);
    expect(mocks.runDynamicWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: {
          interrupt: pending,
          resolutions: [
            { status: "completed", output: "one" },
            { status: "completed", output: "two" },
            expect.objectContaining({
              status: "failed",
              error: expect.stringContaining("WORKFLOW_SUBAGENT_LIMIT_REACHED"),
            }),
          ],
        },
      }),
    );
  });

  it("requires a message for subagent calls", () => {
    expect(readAgentInput({ agentId: "agent-1", message: "continue" })).toEqual({
      agentId: "agent-1",
      message: "continue",
    });
    expect(() => readAgentInput({})).toThrow('require a "message" string');
  });
});
