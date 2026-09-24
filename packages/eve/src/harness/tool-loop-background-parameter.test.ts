import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { DelegatedSessionKey, ScheduleIdKey } from "#context/keys.js";
import { mockModel, type MockModelRequest, type MockModelResponder } from "#evals/mock-model.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import { TASK_CANCEL_WORKFLOW_ID } from "#tasks/cancel-tool.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  BACKGROUND_PARAMETER_DESCRIPTION,
  renderBackgroundTasksInstruction,
} from "#tasks/render.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";

const RESEARCHER: HarnessToolDefinition = {
  description: "Investigate a question before the parent replies.",
  inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
  name: "researcher",
  nodeId: "subagents/researcher",
  workflowId: AGENT_TASK_WORKFLOW_ID,
};

const REMIND: HarnessToolDefinition = {
  description: "Remind Alice later.",
  inputSchema: jsonSchema({ type: "object", properties: { note: { type: "string" } } }),
  name: "remind",
  workflowId: "workflow//./agent/tools/remind//execute",
};

const TASK_CANCEL: HarnessToolDefinition = {
  description: "Stop background agents or tasks by id.",
  inputSchema: jsonSchema({ type: "object", properties: { taskIds: { type: "array" } } }),
  name: "task_cancel",
  workflowId: TASK_CANCEL_WORKFLOW_ID,
};

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
  readonly respond?: MockModelResponder;
  readonly tools?: readonly HarnessToolDefinition[];
}): Promise<{ readonly request: MockModelRequest; readonly session: HarnessSession }> {
  const requests: MockModelRequest[] = [];
  const model = mockModel((request) => {
    requests.push(request);
    return input.respond?.(request) ?? "ok";
  });
  const harness = createToolLoopHarness({
    handleEvent: async () => {},
    mode: input.mode ?? "conversation",
    resolveModel: async () => model,
    tools: new Map((input.tools ?? [RESEARCHER, REMIND]).map((tool) => [tool.name, tool])),
  });
  const ctx = new ContextContainer();
  input.configure?.(ctx);
  const result = await contextStorage.run(ctx, () =>
    harness(SESSION, { message: "Draft the launch post, no rush." }),
  );
  return { request: requests[0]!, session: result.session };
}

function properties(request: MockModelRequest, name: string): Record<string, unknown> {
  const schema = request.tools.find((tool) => tool.name === name)?.inputSchema as
    | { readonly properties?: Record<string, unknown> }
    | undefined;
  return schema?.properties ?? {};
}

describe("the agent tool background parameter", () => {
  it("is offered on agent tools in an interactive root session", async () => {
    const { request } = await firstRequest({});

    expect(properties(request, "researcher").background).toEqual({
      description: BACKGROUND_PARAMETER_DESCRIPTION,
      type: "boolean",
    });
    // Workflow tools keep their authored schema; `detach` is the author's choice.
    expect(properties(request, "remind").background).toBeUndefined();
  });

  it.each([
    ["a task-mode run", { mode: "task" as const }],
    [
      "a session a caller created",
      { configure: (ctx: ContextContainer) => ctx.set(DelegatedSessionKey, true) },
    ],
  ])("is not offered in %s", async (_label, options) => {
    const { request } = await firstRequest(options);

    expect(request.tools.map((tool) => tool.name)).toContain("researcher");
    expect(properties(request, "researcher").background).toBeUndefined();
    expect(properties(request, "researcher").message).toBeDefined();
  });

  it("is offered in a session a schedule created, whose later turns can detach", async () => {
    const { request } = await firstRequest({
      configure: (ctx) => ctx.set(ScheduleIdKey, "daily-report"),
    });

    expect(properties(request, "researcher").background).toEqual({
      description: BACKGROUND_PARAMETER_DESCRIPTION,
      type: "boolean",
    });
  });

  it("offers task_cancel and the agent block when the only agent tools are dynamic", async () => {
    const { request } = await firstRequest({
      configure: (ctx) =>
        ctx.set(BundleKey, {
          subagentRegistry: { dynamicResolvers: [{ kind: "subagent", name: "specialist" }] },
        } as never),
      tools: [TASK_CANCEL],
    });
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.text)
      .join("\n");

    expect(request.tools.map((tool) => tool.name)).toEqual(["task_cancel"]);
    expect(system).toContain(renderBackgroundTasksInstruction({ agents: true }));
  });

  it("adds the background block that defers the [Tasks] note to the agent messaging block", async () => {
    const { request } = await firstRequest({});
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.text)
      .join("\n");

    expect(system).toContain(renderBackgroundTasksInstruction({ agents: true }));
    expect(system).not.toContain(renderBackgroundTasksInstruction({ agents: false }));
  });

  it("commits a background call for the owner with the flag in its input", async () => {
    const { session } = await firstRequest({
      respond: () => ({
        toolCalls: [
          {
            id: "call-draft",
            input: { background: true, message: "Draft the launch post." },
            name: "researcher",
          },
        ],
      }),
    });

    expect(getPendingCoordinationBatch(session.state)?.tasks).toEqual([
      expect.objectContaining({
        callId: "call-draft",
        input: { background: true, message: "Draft the launch post." },
        toolName: "researcher",
        workflowId: AGENT_TASK_WORKFLOW_ID,
      }),
    ]);
  });
});
