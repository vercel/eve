import { expect, it, vi } from "vitest";
import type { ToolContext } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import { startWorkflowBody, type WorkflowBodyInput } from "#execution/tools/workflow/body.js";
import { readWorkflowToolRunRef, WorkflowToolRunAsks } from "#execution/tools/workflow/ask.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), openAgent: vi.fn(), ask: vi.fn() }));
vi.mock("#execution/workflow-registry.js", () => ({ readRegisteredWorkflow: () => mocks.execute }));
vi.mock("#execution/tools/workflow/ask.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ask: mocks.ask,
}));
vi.mock("#execution/agent-sessions/session.js", () => ({
  createAgentSessions: () => ({ close: async () => {}, open: mocks.openAgent }),
}));

const agentContext = { capabilities: { requestInput: true } } as AgentSessionContext;
const owner = { send: vi.fn(), sent: 0 };

it("defaults agent metadata to an empty registry for older workflow payloads", async () => {
  mocks.execute.mockImplementation(async (_input, ctx: WorkflowToolContext) => {
    expect(ctx.agents).toEqual({});
    return null;
  });
  await startWorkflowBody(
    {
      agentContext,
      callId: "legacy-call",
      hookToken: "control",
      input: {},
      session: {
        auth: { current: null, initiator: null },
        id: "session",
        turn: { id: "turn", sequence: 1 },
      },
      stepIndex: 0,
      toolName: "legacy",
      workflowId: "workflow//test//legacy",
      owner,
      runId: "run",
    },
    {
      abortSignal: new AbortController().signal,
      interruptSignal: new AbortController().signal,
    },
    new WorkflowToolRunAsks("run"),
  ).outcome;
});

it("binds workflow-only methods to the run context", async () => {
  const signal = new AbortController().signal;
  const input = {
    agentContext,
    agents: { reviewer: { description: "Review deployments." } },
    callId: "call",
    hookToken: "control",
    input: {},
    session: {
      auth: { current: null, initiator: null },
      id: "session",
      turn: { id: "turn", sequence: 1 },
    },
    stepIndex: 0,
    toolName: "deploy",
    workflowId: "workflow//test//execute",
    owner,
    runId: "run",
  } as WorkflowBodyInput & { runId: string };
  const question = { prompt: "Continue?" };
  const target = "reviewer";
  const session = { send: vi.fn() };
  mocks.ask.mockResolvedValue({ optionId: "yes" });
  mocks.openAgent.mockReturnValue(session);
  mocks.execute.mockImplementation(async (_input, ctx: WorkflowToolContext & ToolContext) => {
    expect(readWorkflowToolRunRef(ctx).runId).toBe("run");
    expect(ctx.abortSignal).toBe(signal);
    expect(ctx.agents).toEqual({ reviewer: { description: "Review deployments." } });
    expect(Object.isFrozen(ctx.agents)).toBe(true);
    expect(Object.isFrozen(ctx.agents.reviewer)).toBe(true);
    const answer = await ctx.ask(question);
    expect(ctx.agent(target)).toBe(session);
    expect(mocks.ask).toHaveBeenCalledWith(ctx, question, undefined);
    expect(mocks.openAgent).toHaveBeenCalledWith(target);
    return { answer };
  });
  const interruptSignal = new AbortController().signal;
  await expect(
    startWorkflowBody(
      input,
      { abortSignal: signal, interruptSignal },
      new WorkflowToolRunAsks("run"),
    ).outcome,
  ).resolves.toEqual({ status: "completed", output: { answer: { optionId: "yes" } } });
});
