import { jsonSchema, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ContextContainer, contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { HandleEventKey } from "#context/keys.js";
import {
  BackgroundToolExecutorKey,
  registerSubagentTaskLauncher,
} from "#harness/background-tools.js";
import { authorizationPendingAsJsonObject } from "#harness/authorization.js";
import {
  countLocalSubagentCalls,
  registerLocalSubagentExecutor,
} from "#execution/tools/subagent/local.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { applyCodeModeTool, CODE_MODE_TOOL_NAME } from "#harness/code-mode-sandbox.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import { CODE_MODE_RUNTIME_OPTIONS } from "#shared/code-mode-runtime.js";
import { never } from "#tools/approval/policies.js";

async function runCodeMode(
  modelTools: ToolSet,
  js: string,
  toolCallId = "code-mode-1",
): Promise<unknown> {
  const execute = modelTools[CODE_MODE_TOOL_NAME]?.execute as
    | ((input: { readonly js: string }, options: any) => unknown)
    | undefined;
  if (execute === undefined) throw new Error("code_mode has no executor");
  return await execute({ js }, { messages: [], toolCallId });
}

function sampleTools(): HarnessToolMap {
  return new Map<string, HarnessToolDefinition>([
    [
      "get_weather",
      {
        description: "Get the weather for a city.",
        execute: async (input: { readonly city: string }) => ({ city: input.city, tempC: 21 }),
        inputSchema: jsonSchema({
          properties: { city: { description: "City to inspect.", type: "string" } },
          required: ["city"],
          type: "object",
        }),
        name: "get_weather",
        outputSchema: z.object({ city: z.string(), tempC: z.number() }),
      },
    ],
    [
      "approved_write",
      {
        approval: never(),
        description: "Write with an explicit approval policy.",
        execute: async () => "written",
        inputSchema: jsonSchema({ type: "object" }),
        name: "approved_write",
        outputSchema: z.string(),
      },
    ],
    [
      "researcher",
      {
        description: "Delegate to a subagent.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "researcher",
        runtimeAction: {
          kind: "subagent-call",
          nodeId: "subagents/researcher",
          subagentName: "researcher",
        },
      },
    ],
    [
      "background_work",
      {
        description: "Start background work.",
        execute: async () => "started",
        execution: "background",
        inputSchema: jsonSchema({ type: "object" }),
        name: "background_work",
        outputSchema: z.string(),
      },
    ],
    [
      "provider_search",
      {
        description: "Provider-managed search.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "provider_search",
      },
    ],
    [
      "connection_search",
      {
        description: "Discover connection tools for a later model response.",
        execute: async () => [],
        inputSchema: jsonSchema({ type: "object" }),
        name: "connection_search",
        outputSchema: z.array(z.object({ qualifiedName: z.string() })),
      },
    ],
    [
      "load_skill",
      {
        description: "Load a skill.",
        execute: async () => "loaded",
        inputSchema: jsonSchema({ type: "object" }),
        name: "load_skill",
        outputSchema: z.string(),
      },
    ],
  ]);
}

describe("applyCodeModeTool", () => {
  it("adds one optional orchestration tool without removing direct tools", async () => {
    const harnessTools = sampleTools();
    const tools = buildToolSet({ tools: harnessTools });
    const { modelTools } = await applyCodeModeTool({
      harnessTools,
      tools,
    });

    expect(Object.keys(modelTools).sort()).toEqual(
      [...Object.keys(tools), CODE_MODE_TOOL_NAME].sort(),
    );
    await expect(
      runCodeMode(modelTools, 'return await tools.get_weather({ city: "lisbon" });'),
    ).resolves.toEqual({ city: "lisbon", tempC: 21 });
  });

  it("describes selection using generic execution properties", async () => {
    const harnessTools = sampleTools();
    const { modelTools } = await applyCodeModeTool({
      harnessTools,
      tools: buildToolSet({ tools: harnessTools }),
    });
    const description = modelTools[CODE_MODE_TOOL_NAME]?.description ?? "";

    expect(description).toContain("later calls depend on earlier results");
    expect(description).toContain("result determines how many calls to make");
    expect(description).toContain("filtering, validation, aggregation");
    expect(description).toContain("read-only or safe to repeat");
    expect(description).toContain("Prefer direct tools for one call");
    expect(description).toContain("at most 64 host calls in total");
    expect(description).not.toMatch(/Snowflake|SQL|metric|d0/u);
  });

  it("catalogs only typed inline tools", async () => {
    const harnessTools = sampleTools();
    const { modelTools } = await applyCodeModeTool({
      harnessTools,
      tools: buildToolSet({ tools: harnessTools }),
    });
    const result = await runCodeMode(modelTools, "return await search({});");

    expect(result).toMatchObject({ items: [{ path: "tools.get_weather" }], remaining: 0 });
  });

  it("leaves ineligible tools direct-only", async () => {
    const harnessTools = new Map(sampleTools());
    const { modelTools } = await applyCodeModeTool({
      harnessTools,
      tools: buildToolSet({ tools: harnessTools }),
    });
    const result = await runCodeMode(modelTools, "return await search({});");

    expect(modelTools.approved_write).toBeDefined();
    expect(modelTools.connection_search).toBeDefined();
    expect(modelTools.provider_search).toBeDefined();
    expect(result).toMatchObject({ items: [{ path: "tools.get_weather" }], remaining: 0 });
  });

  it("admits tasks-enabled subagent launchers but not arbitrary background tools", async () => {
    const launched: Array<{
      batchSize: number;
      callId: string;
      fanoutSize: number;
      name: string;
    }> = [];
    const ctx = new ContextContainer();
    ctx.set(BackgroundToolExecutorKey, {
      async execute({ batch, definition, options }) {
        launched.push({
          batchSize: batch.calls.length,
          callId: options.toolCallId,
          fanoutSize: countLocalSubagentCalls(batch.calls),
          name: definition.name,
        });
        return {
          agentId: definition.name,
          status: "working",
          taskId: `task-${options.toolCallId}`,
        };
      },
      async rollbackCalls() {},
    });
    const executeTaskLauncher = async () => null;
    registerLocalSubagentExecutor(executeTaskLauncher);
    registerSubagentTaskLauncher(executeTaskLauncher, {
      mode: "local",
      preview: ({ callId }) => ({
        agentId: "researcher_task",
        status: "working",
        taskId: `task-${callId}`,
      }),
    });
    const taskLauncher: HarnessToolDefinition = {
      description: "Launch a researcher.",
      execute: executeTaskLauncher,
      execution: "background",
      inputSchema: z.object({ message: z.string() }),
      name: "researcher_task",
      outputSchema: z.object({
        agentId: z.string(),
        status: z.literal("working"),
        taskId: z.string(),
      }),
    };
    const executeRemoteTaskLauncher = async () => null;
    registerSubagentTaskLauncher(executeRemoteTaskLauncher, {
      mode: "remote",
      preview: ({ callId }) => ({
        agentId: "reviewer_task",
        status: "working",
        taskId: `task-${callId}`,
      }),
    });
    const remoteTaskLauncher: HarnessToolDefinition = {
      ...taskLauncher,
      description: "Launch a remote reviewer.",
      execute: executeRemoteTaskLauncher,
      name: "reviewer_task",
    };
    const backgroundWork = sampleTools().get("background_work")!;
    const launchCount: HarnessToolDefinition = {
      description: "Report how many staged launches have executed.",
      execute: async () => launched.length,
      inputSchema: z.object({}),
      name: "get_launch_count",
      outputSchema: z.number(),
    };
    const harnessTools = new Map<string, HarnessToolDefinition>([
      [taskLauncher.name, taskLauncher],
      [remoteTaskLauncher.name, remoteTaskLauncher],
      [backgroundWork.name, backgroundWork],
      [launchCount.name, launchCount],
    ]);
    const modelTools = buildToolSet({ tools: harnessTools });
    const emissionState = {
      sequence: 1,
      sessionStarted: true,
      stepIndex: 0,
      turnId: "turn-1",
    } as const;
    const session: import("#harness/types.js").HarnessSession = {
      agent: { modelReference: { id: "mock" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
    };
    const applied = await contextStorage.run(ctx, () =>
      applyCodeModeTool({ emissionState, harnessTools, session, tools: modelTools }),
    );
    await modelTools.researcher_task!.onInputAvailable!({
      context: undefined,
      input: { message: "direct launch" },
      messages: [],
      toolCallId: "direct-task",
    });
    await modelTools.background_work!.onInputAvailable!({
      context: undefined,
      input: {},
      messages: [],
      toolCallId: "direct-background-work",
    });

    const result = await runCodeMode(
      applied.modelTools,
      `const receipts = await Promise.all([
        tools.researcher_task({ message: "investigate" }),
        tools.researcher_task({ message: "verify" }),
        tools.reviewer_task({ message: "review" }),
      ]);
      return { launchesInsideProgram: await tools.get_launch_count({}), receipts };`,
    );
    const secondResult = await runCodeMode(
      applied.modelTools,
      'return await tools.researcher_task({ message: "verify" });',
      "code-mode-2",
    );

    expect(result).toEqual({
      launchesInsideProgram: 0,
      receipts: [
        expect.objectContaining({ agentId: "researcher_task", status: "working" }),
        expect.objectContaining({ agentId: "researcher_task", status: "working" }),
        expect.objectContaining({ agentId: "reviewer_task", status: "working" }),
      ],
    });
    expect(secondResult).toMatchObject({ agentId: "researcher_task", status: "working" });
    expect(launched.slice(0, 3)).toEqual(
      expect.arrayContaining([
        { batchSize: 5, callId: "code-mode-1:tool-1", fanoutSize: 3, name: "researcher_task" },
        { batchSize: 5, callId: "code-mode-1:tool-2", fanoutSize: 3, name: "researcher_task" },
        { batchSize: 5, callId: "code-mode-1:tool-3", fanoutSize: 3, name: "reviewer_task" },
      ]),
    );
    expect(launched[3]).toEqual({
      batchSize: 6,
      callId: "code-mode-2:tool-1",
      fanoutSize: 4,
      name: "researcher_task",
    });
    expect(
      await runCodeMode(
        applied.modelTools,
        'return await search({ query: "reviewer" });',
        "code-mode-search",
      ),
    ).toMatchObject({
      items: [expect.objectContaining({ path: "tools.reviewer_task" })],
      remaining: 0,
    });

    await expect(
      runCodeMode(
        applied.modelTools,
        'await tools.researcher_task({ message: "discard" }); throw new Error("failed");',
        "code-mode-failed",
      ),
    ).rejects.toThrow("failed");
    expect(launched).toHaveLength(4);
    await runCodeMode(
      applied.modelTools,
      'return await tools.researcher_task({ message: "recover" });',
      "code-mode-recovery",
    );
    expect(launched.at(-1)).toMatchObject({
      callId: "code-mode-recovery:tool-1",
      fanoutSize: 5,
    });
  });

  it("searches the complete catalog and invokes an omitted result in the same program", async () => {
    const largeInput = Object.fromEntries(
      Array.from({ length: 900 }, (_, index) => [`field_${index}`, { type: "string" as const }]),
    );
    const harnessTools: HarnessToolMap = new Map([
      [
        "small_tool",
        {
          description: "Return a small value.",
          execute: async () => 1,
          inputSchema: jsonSchema({ type: "object" }),
          name: "small_tool",
          outputSchema: z.number(),
        },
      ],
      [
        "large_tool",
        {
          description: "Find the specially requested value.",
          execute: async () => ({ found: true }),
          inputSchema: jsonSchema({ properties: largeInput, type: "object" }),
          name: "large_tool",
          outputSchema: z.object({ found: z.boolean() }),
        },
      ],
    ]);
    const { modelTools } = await applyCodeModeTool({
      harnessTools,
      tools: buildToolSet({ tools: harnessTools }),
    });

    expect(modelTools[CODE_MODE_TOOL_NAME]?.description?.length).toBeLessThanOrEqual(8_000);
    await expect(
      runCodeMode(
        modelTools,
        `
          const found = await search({ query: "specially requested" });
          const item = found.items[0];
          const key = item.path.startsWith("tools.")
            ? item.path.slice(6)
            : JSON.parse(item.path.slice(6, -1));
          return { path: item.path, value: await tools[key]({}) };
        `,
      ),
    ).resolves.toEqual({ path: "tools.large_tool", value: { found: true } });
  });

  it("rejects malformed nested output before it enters the program", async () => {
    const harnessTools: HarnessToolMap = new Map([
      [
        "invalid_output",
        {
          description: "Return malformed data.",
          execute: async () => ({ value: "wrong" }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "invalid_output",
          outputSchema: z.object({ value: z.number() }),
        },
      ],
    ]);
    const { modelTools } = await applyCodeModeTool({
      harnessTools,
      tools: buildToolSet({ tools: harnessTools }),
    });

    await expect(runCodeMode(modelTools, "return await tools.invalid_output({});")).rejects.toThrow(
      "Host tool failed",
    );
  });

  it("leaves validation-free output schemas direct-only", async () => {
    const outputSchema = {
      properties: {
        value: { $ref: "#/properties/nested/properties/value" },
        nested: { properties: { value: { type: "number" } }, type: "object" },
      },
      type: "object",
    };
    const harnessTools: HarnessToolMap = new Map([
      [
        "passthrough_output",
        {
          description: "Return data behind an unsupported output schema.",
          execute: async () => ({ nested: { value: 1 }, value: 1 }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "passthrough_output",
          outputSchema: outputSchema as never,
        },
      ],
    ]);

    const { modelTools } = await applyCodeModeTool({
      harnessTools,
      tools: buildToolSet({ tools: harnessTools }),
    });
    expect(modelTools.passthrough_output).toBeDefined();
    expect(modelTools).not.toHaveProperty(CODE_MODE_TOOL_NAME);
  });

  it("leaves validation-free input schemas direct-only", async () => {
    const unsupportedInputSchema = {
      properties: {
        value: { $ref: "#/properties/nested/properties/value" },
        nested: { properties: { value: { type: "number" } }, type: "object" },
      },
      type: "object",
    };
    const harnessTools: HarnessToolMap = new Map([
      [
        "passthrough_input",
        {
          description: "Accept data behind an unsupported input schema.",
          execute: async () => ({ ok: true }),
          inputSchema: unsupportedInputSchema as never,
          name: "passthrough_input",
          outputSchema: z.object({ ok: z.boolean() }),
        },
      ],
    ]);

    const { modelTools } = await applyCodeModeTool({
      harnessTools,
      tools: buildToolSet({ tools: harnessTools }),
    });
    expect(modelTools.passthrough_input).toBeDefined();
    expect(modelTools).not.toHaveProperty(CODE_MODE_TOOL_NAME);
  });

  it("rejects nested authorization and directs the model to the direct tool", async () => {
    const harnessTools: HarnessToolMap = new Map([
      [
        "authorized_query",
        {
          description: "Run an authorized query.",
          execute: async () => ({ value: 1 }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "authorized_query",
          outputSchema: z.object({ value: z.number() }),
        },
      ],
    ]);
    const modelTools: ToolSet = {
      authorized_query: {
        description: "Run an authorized query.",
        execute: async () => authorizationPendingAsJsonObject({ connections: ["warehouse"] }),
        inputSchema: jsonSchema({ type: "object" }),
        outputSchema: z.object({ value: z.number() }),
      } as ToolSet[string],
    };
    const { modelTools: tools } = await applyCodeModeTool({
      harnessTools,
      tools: modelTools,
    });

    await expect(runCodeMode(tools, "return await tools.authorized_query({});")).rejects.toThrow(
      "requires authorization and must be called directly",
    );
  });

  it("uses typed raw intermediates inside code mode without changing direct projections", async () => {
    const events: any[] = [];
    const context = new ContextContainer();
    context.setVirtualContext(HandleEventKey, async (event) => {
      events.push(event);
    });
    const project = vi.fn(() => ({ type: "text" as const, value: "projected" }));
    const harnessTools: HarnessToolMap = new Map([
      [
        "query",
        {
          description: "Run a query.",
          execute: async () => ({ rows: [{ count: 3 }] }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "query",
          outputSchema: z.object({ rows: z.array(z.object({ count: z.number() })) }),
          toModelOutput: project,
        },
      ],
    ]);
    const { modelTools } = await contextStorage.run(context, () =>
      applyCodeModeTool({
        emissionState: { sessionStarted: true, sequence: 2, stepIndex: 3, turnId: "turn-1" },
        harnessTools,
        tools: buildToolSet({ tools: harnessTools }),
      }),
    );

    await expect(runCodeMode(modelTools, "return await tools.query({});")).resolves.toEqual({
      rows: [{ count: 3 }],
    });
    expect(project).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["actions.requested", "action.result"]);
  });

  it("keeps internal catalog search out of domain tool events", async () => {
    const events: any[] = [];
    const context = new ContextContainer();
    context.setVirtualContext(HandleEventKey, async (event) => {
      events.push(event);
    });
    const harnessTools = sampleTools();
    const { modelTools } = await contextStorage.run(context, () =>
      applyCodeModeTool({
        emissionState: { sessionStarted: true, sequence: 2, stepIndex: 3, turnId: "turn-1" },
        harnessTools,
        tools: buildToolSet({ tools: harnessTools }),
      }),
    );

    await runCodeMode(modelTools, 'return await search({ query: "weather" });');
    expect(events).toEqual([]);
  });

  it("preserves active Eve context across the bridge", async () => {
    const SentinelKey = new ContextKey<string>("code-mode-test-sentinel");
    const context = new ContextContainer();
    context.set(SentinelKey, "active");
    const harnessTools: HarnessToolMap = new Map([
      [
        "read_context",
        {
          description: "Read active context.",
          execute: async () => loadContext().require(SentinelKey),
          inputSchema: jsonSchema({ type: "object" }),
          name: "read_context",
          outputSchema: z.string(),
        },
      ],
    ]);
    const { modelTools } = await contextStorage.run(context, () =>
      applyCodeModeTool({
        harnessTools,
        tools: buildToolSet({ tools: harnessTools }),
      }),
    );

    await expect(runCodeMode(modelTools, "return await tools.read_context({});")).resolves.toBe(
      "active",
    );
  });

  it("uses bounded execution", () => {
    expect(CODE_MODE_RUNTIME_OPTIONS).toEqual({
      executionPolicy: {
        maxBridgeRequests: 64,
        maxInFlightBridgeRequests: 8,
        timeoutMs: 300_000,
      },
    });
  });
});
