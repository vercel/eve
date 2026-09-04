import { expect, it, vi } from "vitest";
import type { ToolContext } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import { executeWorkflowBody, type WorkflowBodyInput } from "#execution/tools/workflow/body.js";
import { readWorkflowToolRunRef } from "#execution/tools/workflow/ask.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), agent: vi.fn(), ask: vi.fn() }));
vi.mock("#execution/workflow-registry.js", () => ({ readRegisteredWorkflow: () => mocks.execute }));
vi.mock("#execution/tools/subagent/invoke-agent.js", () => ({ agent: mocks.agent }));
vi.mock("#execution/tools/workflow/ask.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ask: mocks.ask,
}));

it("binds workflow-only methods to the run context", async () => {
  const signal = new AbortController().signal;
  const input = {
    callId: "call",
    input: {},
    session: { id: "session", turn: { id: "turn", sequence: 1 } },
    stepIndex: 0,
    toolName: "deploy",
    workflowId: "workflow//test//execute",
    owner: { inbox: "inbox" },
    execution: "blocking",
    runId: "run",
  } as WorkflowBodyInput & { execution: "blocking"; runId: string };
  const question = { prompt: "Continue?" };
  const invocation = { key: "review", target: "reviewer", message: "Review" };
  mocks.ask.mockResolvedValue({ optionId: "yes" });
  mocks.agent.mockResolvedValue("reviewed");
  mocks.execute.mockImplementation(async (_input, ctx: WorkflowToolContext & ToolContext) => {
    expect(readWorkflowToolRunRef(ctx).runId).toBe("run");
    expect(ctx.abortSignal).toBe(signal);
    const answer = await ctx.ask(question);
    const result = await ctx.agent(invocation);
    expect(mocks.ask).toHaveBeenCalledWith(ctx, question);
    expect(mocks.agent).toHaveBeenCalledWith(ctx, invocation);
    return { answer, result };
  });
  await expect(executeWorkflowBody(input, signal)).resolves.toEqual({
    outcome: { status: "completed", output: { answer: { optionId: "yes" }, result: "reviewed" } },
    reportCount: 0,
  });
});
