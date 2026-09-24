import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { DelegatedSessionKey } from "#context/keys.js";
import { mockModel, type MockModelRequest } from "#evals/mock-model.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import { TASK_CANCEL_WORKFLOW_ID } from "#tasks/cancel-tool.js";
import { renderTasksInstruction } from "#tasks/render.js";
import { TASK_WAIT_WORKFLOW_ID } from "#tasks/wait-tool.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";

const RESEARCHER: HarnessToolDefinition = {
  description: "Investigate a question before the parent replies.",
  inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
  name: "researcher",
  nodeId: "subagents/researcher",
  workflowId: AGENT_TASK_WORKFLOW_ID,
};

const ASK: HarnessToolDefinition = {
  attached: true,
  description: "Ask Alice a question.",
  inputSchema: jsonSchema({ type: "object", properties: { question: { type: "string" } } }),
  name: "ask_question",
  workflowId: "workflow//./agent/tools/ask//execute",
};

const TASK_TOOLS: readonly HarnessToolDefinition[] = [
  {
    description: "Stop a task by id.",
    inputSchema: jsonSchema({ type: "object", properties: { taskId: { type: "string" } } }),
    name: "task_cancel",
    workflowId: TASK_CANCEL_WORKFLOW_ID,
  },
  {
    description: "Wait for a task by id.",
    inputSchema: jsonSchema({ type: "object", properties: { taskId: { type: "string" } } }),
    name: "task_wait",
    workflowId: TASK_WAIT_WORKFLOW_ID,
  },
];

const SESSION: HarnessSession = {
  agent: { modelReference: { id: "model" }, system: "Test assistant", tools: [] },
  compaction: { recentWindowSize: 10, threshold: 100_000 },
  continuationToken: "session",
  history: [],
  sessionId: "session",
};

async function firstRequest(input: {
  readonly configure?: (ctx: ContextContainer) => void;
  readonly mode?: "conversation" | "task";
  readonly tools: readonly HarnessToolDefinition[];
}): Promise<{ readonly request: MockModelRequest; readonly system: string }> {
  const requests: MockModelRequest[] = [];
  const model = mockModel((request) => {
    requests.push(request);
    return "ok";
  });
  const harness = createToolLoopHarness({
    handleEvent: async () => {},
    mode: input.mode ?? "conversation",
    resolveModel: async () => model,
    tools: new Map([...input.tools, ...TASK_TOOLS].map((tool) => [tool.name, tool])),
  });
  const ctx = new ContextContainer();
  input.configure?.(ctx);
  await contextStorage.run(ctx, () => harness(SESSION, { message: "Draft the launch post." }));
  const request = requests[0]!;
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.text)
    .join("\n");
  return { request, system };
}

describe("the task surface", () => {
  it.each([
    ["an interactive root session", {}],
    ["a task-mode run", { mode: "task" as const }],
    [
      "a session a caller created",
      { configure: (ctx: ContextContainer) => ctx.set(DelegatedSessionKey, true) },
    ],
  ])("offers task_wait, task_cancel, and the tasks block in %s", async (_label, options) => {
    const { request, system } = await firstRequest({ ...options, tools: [RESEARCHER] });

    expect(request.tools.map((tool) => tool.name).toSorted()).toEqual([
      "researcher",
      "task_cancel",
      "task_wait",
    ]);
    expect(system).toContain(renderTasksInstruction({ agents: true }));
    // Agent tools keep their one input schema; there is no per-session parameter.
    const schema = request.tools.find((tool) => tool.name === "researcher")?.inputSchema as {
      readonly properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual([
      "agentId",
      "message",
      "outputSchema",
    ]);
  });

  it("offers the task tools and block when the only agent tools are dynamic", async () => {
    const { request, system } = await firstRequest({
      configure: (ctx) =>
        ctx.set(BundleKey, {
          subagentRegistry: { dynamicResolvers: [{ kind: "subagent", name: "specialist" }] },
        } as never),
      tools: [],
    });

    expect(request.tools.map((tool) => tool.name).toSorted()).toEqual(["task_cancel", "task_wait"]);
    expect(system).toContain(renderTasksInstruction({ agents: true }));
  });

  it("offers neither when every workflow tool is attached", async () => {
    const { request, system } = await firstRequest({ tools: [ASK] });

    expect(request.tools.map((tool) => tool.name)).toEqual(["ask_question"]);
    expect(system).not.toContain("task_wait");
  });
});
