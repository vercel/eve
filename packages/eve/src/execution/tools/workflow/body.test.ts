import { expect, it, vi } from "vitest";
import type { ToolContext } from "#tools/definition.js";
import type {
  ResumableWorkflowToolContext,
  WorkflowToolContext,
} from "#tools/workflow-definition.js";
import {
  executeWorkflowBody,
  firstGenerationCall,
  type WorkflowBodyInput,
} from "#execution/tools/workflow/body.js";
import { readWorkflowToolRunAgentContext } from "#execution/tools/workflow/ask.js";
import { createGenerations } from "#execution/tools/workflow/generations.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), agent: vi.fn(), ask: vi.fn() }));
vi.mock("#execution/workflow-registry.js", () => ({ readRegisteredWorkflow: () => mocks.execute }));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: vi.fn() }));
vi.mock("#execution/tools/workflow/agent.js", () => ({ agent: mocks.agent }));
vi.mock("#execution/tools/workflow/ask.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ask: mocks.ask,
}));

it("defaults agent metadata to an empty registry for older workflow payloads", async () => {
  mocks.execute.mockImplementation(async (_input, ctx: WorkflowToolContext) => {
    expect(ctx.agents).toEqual({});
    return null;
  });
  await executeWorkflowBody(
    {
      callId: "legacy-call",
      input: {},
      session: {
        auth: { current: null, initiator: null },
        id: "session",
        turn: { id: "turn", sequence: 1 },
      },
      stepIndex: 0,
      taskId: "legacy-abc234",
      toolName: "legacy",
      workflowId: "workflow//test//legacy",
      owner: { inbox: "inbox" },
      runId: "run",
    },
    new AbortController().signal,
  );
});

it("binds workflow-only methods to the run context", async () => {
  const signal = new AbortController().signal;
  const input = {
    agents: { reviewer: { description: "Review deployments." } },
    callId: "call",
    input: {},
    session: {
      auth: { current: null, initiator: null },
      id: "session",
      turn: { id: "turn", sequence: 1 },
    },
    stepIndex: 0,
    taskId: "deploy-abc234",
    toolName: "deploy",
    workflowId: "workflow//test//execute",
    owner: { inbox: "inbox" },
    runId: "run",
  } as WorkflowBodyInput & { runId: string };
  const question = { prompt: "Continue?" };
  const target = "reviewer";
  const invocation = { message: "Review" };
  mocks.ask.mockResolvedValue({ optionId: "yes" });
  mocks.agent.mockResolvedValue("reviewed");
  mocks.execute.mockImplementation(async (_input, ctx: WorkflowToolContext & ToolContext) => {
    expect(readWorkflowToolRunAgentContext(ctx).from).toMatchObject({
      generation: 1,
      runId: "run",
    });
    expect(ctx.abortSignal).toBe(signal);
    expect(ctx.agents).toEqual({ reviewer: { description: "Review deployments." } });
    expect(Object.isFrozen(ctx.agents)).toBe(true);
    expect(Object.isFrozen(ctx.agents.reviewer)).toBe(true);
    const answer = await ctx.ask(question);
    const result = await ctx.agent(target, invocation);
    expect(mocks.ask).toHaveBeenCalledWith(ctx, question);
    expect(mocks.agent).toHaveBeenCalledWith(ctx, target, invocation, undefined);
    return { answer, result };
  });
  await expect(executeWorkflowBody(input, signal)).resolves.toEqual({
    outcome: { status: "completed", output: { answer: { optionId: "yes" }, result: "reviewed" } },
    reportCount: 0,
  });
});

it("relays a resumable body's yields as progress, never as its result", async () => {
  const input = {
    callId: "call",
    input: { version: "0.67" },
    resumable: true,
    session: {
      auth: { current: null, initiator: null },
      id: "session",
      turn: { id: "turn", sequence: 1 },
    },
    stepIndex: 0,
    taskId: "release_notes-abc234",
    toolName: "release_notes",
    workflowId: "workflow//test//release_notes",
    owner: { inbox: "inbox" },
    runId: "run",
  } as WorkflowBodyInput & { runId: string };
  const generations = createGenerations(firstGenerationCall(input));
  mocks.execute.mockImplementation(async function* (
    _input: unknown,
    ctx: ResumableWorkflowToolContext<unknown, unknown>,
  ) {
    yield { stage: "drafting" };
    ctx.reply("notes");
  });

  const result = await executeWorkflowBody(input, new AbortController().signal, generations);

  // The bare return after the reply is no second result, even after a yield.
  expect(result).toEqual({ outcome: { output: null, status: "completed" }, reportCount: 1 });
  expect(resumeHookStep).toHaveBeenCalledExactlyOnceWith("inbox", {
    from: expect.objectContaining({ generation: 1, taskId: "release_notes-abc234" }),
    kind: "report",
    update: { stage: "drafting" },
  });
  // The reply waits for that report to reach the owner.
  expect(generations.next(0)).toBeUndefined();
  expect(generations.next(1)).toMatchObject({ kind: "reply", result: { output: "notes" } });
});
