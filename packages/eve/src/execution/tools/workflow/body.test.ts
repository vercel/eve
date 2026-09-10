import { expect, it, vi } from "vitest";
import type { ToolContext } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import { executeWorkflowBody, type WorkflowBodyInput } from "#execution/tools/workflow/body.js";
import {
  findWorkflowToolRunContext,
  readWorkflowToolRunRef,
} from "#execution/tools/workflow/ask.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  agent: vi.fn(),
  ask: vi.fn(),
  resumeHook: vi.fn(),
}));
vi.mock("#execution/workflow-registry.js", () => ({ readRegisteredWorkflow: () => mocks.execute }));
vi.mock("#execution/tools/subagent/invoke-agent.js", () => ({ agent: mocks.agent }));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.resumeHook,
}));
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
  const target = "reviewer";
  const invocation = { message: "Review" };
  mocks.ask.mockResolvedValue({ optionId: "yes" });
  mocks.agent.mockResolvedValue("reviewed");
  mocks.execute.mockImplementation(async (_input, ctx: WorkflowToolContext & ToolContext) => {
    expect(readWorkflowToolRunRef(ctx).runId).toBe("run");
    expect(ctx.abortSignal).toBe(signal);
    const answer = await ctx.ask(question);
    const result = await ctx.agent(target, invocation);
    expect(mocks.ask).toHaveBeenCalledWith(ctx, question);
    expect(mocks.agent).toHaveBeenCalledWith(ctx, target, invocation);
    return { answer, result };
  });
  await expect(executeWorkflowBody(input, signal)).resolves.toEqual({
    outcome: { status: "completed", output: { answer: { optionId: "yes" }, result: "reviewed" } },
    reportCount: 0,
  });
});

it.each([
  { execution: "background", authorizationSupported: undefined, expected: false },
  { execution: "background", authorizationSupported: false, expected: false },
  { execution: "background", authorizationSupported: true, expected: true },
  { execution: "blocking", authorizationSupported: undefined, expected: true },
] as const)(
  "binds auth support to the actual owner ($execution, $authorizationSupported)",
  async ({ execution, authorizationSupported, expected }) => {
    mocks.execute.mockImplementation(async (_input, ctx) => {
      expect(findWorkflowToolRunContext(ctx)?.authorizationSupported).toBe(expected);
      return "done";
    });
    await expect(
      executeWorkflowBody(
        {
          authorizationSupported,
          callId: "call",
          input: {},
          session: {
            id: "session",
            auth: { current: null, initiator: null },
            turn: { id: "turn", sequence: 1 },
          },
          stepIndex: 0,
          taskId: "task",
          toolName: "deploy",
          workflowId: "workflow//test//execute",
          owner: { inbox: "inbox" },
          execution,
          runId: "run",
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome: { status: "completed", output: "done" } });
  },
);

it("assigns stable distinct identities to repeated yielded content", async () => {
  mocks.resumeHook.mockReset();
  mocks.execute.mockImplementation(async function* () {
    yield { progress: 0.5 };
    yield { progress: 0.5 };
    return "done";
  });
  const input = {
    callId: "call",
    input: {},
    session: {
      id: "session",
      auth: { current: null, initiator: null },
      turn: { id: "turn", sequence: 1 },
    },
    stepIndex: 0,
    taskId: "task",
    toolName: "export",
    workflowId: "workflow//test//execute",
    owner: { inbox: "inbox" },
    execution: "background" as const,
    runId: "run",
  };
  for (let replay = 0; replay < 2; replay += 1) {
    const result = await executeWorkflowBody(input, new AbortController().signal);
    expect(result).toEqual({
      outcome: { status: "completed", output: "done" },
      reportCount: 2,
    });
  }
  expect(mocks.resumeHook.mock.calls.map(([, report]) => report.reportId)).toEqual([
    "yield:0",
    "yield:1",
    "yield:0",
    "yield:1",
  ]);
});
