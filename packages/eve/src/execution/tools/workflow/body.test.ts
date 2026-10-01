import { expect, it, vi } from "vitest";
import type { ToolContext } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import { startCallBody, type WorkflowBodyInput } from "#execution/tools/workflow/body.js";
import { findWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
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

const agentContext = {
  agents: { reviewer: { description: "Review deployments." } },
  capabilities: { requestInput: true },
} as Partial<AgentSessionContext> as AgentSessionContext;

it("binds workflow-only methods to the run context", async () => {
  const input = {
    agentContext,
    callId: "call",
    entry: { entryPoint: "execute" },
    hookToken: "control",
    input: {},
    turn: {},
    session: {
      context: {},
      auth: { current: null, initiator: null },
      id: "session",
      turn: { id: "turn", sequence: 1 },
    },
    stepIndex: 0,
    toolName: "deploy",
    workflowId: "workflow//test//execute",
    owner: { send: vi.fn(), sent: 0 },
    runId: "run",
  } as WorkflowBodyInput;
  const question = { prompt: "Continue?" };
  const target = "reviewer";
  const session = { send: vi.fn() };
  mocks.ask.mockResolvedValue({ optionId: "yes" });
  mocks.openAgent.mockReturnValue(session);
  mocks.execute.mockImplementation(async (_input, ctx: WorkflowToolContext & ToolContext) => {
    expect(findWorkflowToolRunContext(ctx)?.from.runId).toBe("run");
    expect(ctx.agents).toEqual({ reviewer: { description: "Review deployments." } });
    expect(Object.isFrozen(ctx.agents)).toBe(true);
    expect(Object.isFrozen(ctx.agents.reviewer)).toBe(true);
    const answer = await ctx.ask(question);
    expect(ctx.agent(target)).toBe(session);
    expect(mocks.ask).toHaveBeenCalledWith(ctx, question, undefined);
    expect(mocks.openAgent).toHaveBeenCalledWith(target);
    return { answer };
  });
  const started = startCallBody(input);
  await expect(started.outcome).resolves.toEqual({
    status: "completed",
    output: { answer: { optionId: "yes" } },
  });
});
