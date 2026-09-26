import { expect, it, vi } from "vitest";
import type { ToolContext } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import { executeWorkflowBody, type WorkflowBodyInput } from "#execution/tools/workflow/body.js";
import { readWorkflowToolRunRef } from "#execution/tools/workflow/ask.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { AgentSessions } from "#execution/agent-sessions/session.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), openAgent: vi.fn(), ask: vi.fn() }));
vi.mock("#execution/workflow-registry.js", () => ({ readRegisteredWorkflow: () => mocks.execute }));
vi.mock("#execution/tools/workflow/ask.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ask: mocks.ask,
}));

const agentContext = { capabilities: { requestInput: true } } as AgentSessionContext;
const agentSessions = new AgentSessions({
  context: agentContext,
  from: {} as never,
  inbox: "inbox",
});
vi.spyOn(agentSessions, "open").mockImplementation(mocks.openAgent);

it("defaults agent metadata to an empty registry for older workflow payloads", async () => {
  mocks.execute.mockImplementation(async (_input, ctx: WorkflowToolContext) => {
    expect(ctx.agents).toEqual({});
    return null;
  });
  await executeWorkflowBody(
    {
      agentContext,
      callId: "legacy-call",
      input: {},
      session: {
        auth: { current: null, initiator: null },
        id: "session",
        turn: { id: "turn", sequence: 1 },
      },
      stepIndex: 0,
      toolName: "legacy",
      workflowId: "workflow//test//legacy",
      owner: { inbox: "inbox" },
      runId: "run",
    },
    {
      abortSignal: new AbortController().signal,
      agentSessions,
      interruptSignal: new AbortController().signal,
    },
  );
});

it("binds workflow-only methods to the run context", async () => {
  const signal = new AbortController().signal;
  const input = {
    agentContext,
    agents: { reviewer: { description: "Review deployments." } },
    callId: "call",
    input: {},
    session: {
      auth: { current: null, initiator: null },
      id: "session",
      turn: { id: "turn", sequence: 1 },
    },
    stepIndex: 0,
    toolName: "deploy",
    workflowId: "workflow//test//execute",
    owner: { inbox: "inbox" },
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
    executeWorkflowBody(input, { abortSignal: signal, agentSessions, interruptSignal }),
  ).resolves.toEqual({
    outcome: { status: "completed", output: { answer: { optionId: "yes" } } },
    reportCount: 0,
  });
});
