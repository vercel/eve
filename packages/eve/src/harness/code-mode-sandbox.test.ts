import { jsonSchema, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ContextContainer, contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { HandleEventKey } from "#context/keys.js";
import { authorizationPendingAsJsonObject } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { applyCodeModeTool, CODE_MODE_TOOL_NAME } from "#harness/code-mode-sandbox.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import { CODE_MODE_RUNTIME_OPTIONS } from "#shared/code-mode-runtime.js";
import { never } from "#tools/approval/policies.js";

async function runCodeMode(modelTools: ToolSet, js: string): Promise<unknown> {
  const execute = modelTools[CODE_MODE_TOOL_NAME]?.execute as
    | ((input: { readonly js: string }, options: any) => unknown)
    | undefined;
  if (execute === undefined) throw new Error("code_mode has no executor");
  return await execute({ js }, { messages: [], toolCallId: "code-mode-1" });
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
