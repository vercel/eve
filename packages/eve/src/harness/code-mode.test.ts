import { asSchema, jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  CODE_MODE_TOOL_NAME,
  applyCodeModeTool,
  codeModeBridgeRequestLimit,
  claimsForCodeMode,
  createDiscoveryTools,
  DESCRIBE_TOOLS_NAME,
  SEARCH_TOOLS_NAME,
} from "#harness/code-mode.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import { always } from "#tools/approval/policies.js";
import { parseCodeModeWorkflowInput } from "#execution/code-mode/schema.js";
import { codeModeWorkflowReference } from "#execution/code-mode/workflow-reference.js";

const continuationSecurity = { signingKey: "code-mode-test-key" };

function tool(name: string, extra: Partial<HarnessToolDefinition> = {}): HarnessToolDefinition {
  return {
    description: `Tool ${name}.`,
    execute: async () => name,
    inputSchema: jsonSchema({ type: "object", properties: { q: { type: "string" } } }),
    name,
    ...extra,
  };
}

function codeModeDefinition(): HarnessToolDefinition {
  return {
    behavior: { availability: ["root-session"] },
    description: "Execute one JavaScript program.",
    inputSchema: jsonSchema({ type: "object", properties: { js: { type: "string" } } }),
    name: CODE_MODE_TOOL_NAME,
    workflowId: codeModeWorkflowReference.workflowId,
  };
}

function subagent(name: string): HarnessToolDefinition {
  return {
    behavior: {
      availability: [],
      handling: {
        kind: "dispatch",
        target: { kind: "subagent-call", nodeId: `subagents/${name}`, subagentName: name },
      },
    },
    description: `Delegate to ${name}.`,
    inputSchema: jsonSchema({ type: "object" }),
    name,
    nodeId: `subagents/${name}`,
    resultKind: "subagent",
    workflowId: "workflow//eve//subagentToolExecuteWorkflow",
  };
}

describe("claimsForCodeMode", () => {
  it("claims blocking ungated tools and subagents while keeping other background tools direct", () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["add", tool("add")],
      ["gated", tool("gated", { approval: always() })],
      ["skill", tool("skill", { behavior: { availability: [], presentation: "load-skill" } })],
      ["provider", tool("provider", { execute: undefined })],
      [SEARCH_TOOLS_NAME, tool(SEARCH_TOOLS_NAME)],
      [DESCRIBE_TOOLS_NAME, tool(DESCRIBE_TOOLS_NAME)],
      ["background", tool("background", { execution: "background" })],
      ["researcher", subagent("researcher")],
      ["agent", { ...subagent("agent"), execution: "background" }],
      ["authored_wf", tool("authored_wf", { workflowId: "workflow//app//authored" })],
      ["task_cancel", tool("task_cancel", { runtimeAction: { kind: "task-control" } })],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);

    const claimed = [...tools.keys()].filter((name) => claimsForCodeMode(name, tools));
    expect(claimed).toEqual(["add", "researcher", "agent"]);
  });
});

describe("applyCodeModeTool", () => {
  it.each(["eager", "lazy"] as const)(
    "pins the configured subagent budget in %s mode",
    async (mode) => {
      const harnessTools = new Map([[CODE_MODE_TOOL_NAME, codeModeDefinition()]]);
      const applied = await applyCodeModeTool({
        continuationSecurity,
        harnessTools,
        mode,
        maxSubagents: 300,
        tools: buildToolSet({ tools: harnessTools }),
      });
      const input = applied.harnessTools.get(CODE_MODE_TOOL_NAME)!.executeInput!({
        js: "return null;",
      });
      expect(parseCodeModeWorkflowInput(JSON.parse(JSON.stringify(input))).maxSubagents).toBe(300);
      expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain(
        "at most 300 subagents",
      );
      expect(codeModeBridgeRequestLimit(300)).toBeGreaterThan(300);
    },
  );

  it("keeps eager tools callable directly and pins the program catalog into executeInput", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["add", tool("add")],
      ["gated", tool("gated", { approval: always() })],
      ["researcher", subagent("researcher")],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);
    const tools = buildToolSet({ tools: harnessTools });
    const applied = await applyCodeModeTool({
      continuationSecurity,
      harnessTools,
      mode: "eager",
      tools,
    });

    expect(applied.claimedToolNames).toEqual(["add", "researcher"]);
    expect(Object.keys(applied.modelTools).sort()).toEqual([
      "add",
      CODE_MODE_TOOL_NAME,
      "gated",
      "researcher",
    ]);
    expect(applied.modelTools.add).toBe(tools.add);
    expect(applied.modelTools.researcher).toBe(tools.researcher);
    expect(applied.modelTools.gated).toBe(tools.gated);
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain(
      "Prefer code_mode for dependent lookups",
    );
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain("Prefer direct tools");
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.execute).toBeUndefined();
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain("add");
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain("researcher");

    const definition = applied.harnessTools.get(CODE_MODE_TOOL_NAME);
    expect(definition?.workflowId).toBe(codeModeWorkflowReference.workflowId);
    const executeInput = definition?.executeInput?.({ js: "return 1;" });
    expect(parseCodeModeWorkflowInput(executeInput)).toMatchObject({
      js: "return 1;",
      mode: "eager",
      toolNames: ["add", "researcher"],
    });
  });

  it("lists names only and advertises discovery helpers in lazy mode", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["add", tool("add")],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);
    const applied = await applyCodeModeTool({
      continuationSecurity,
      harnessTools,
      mode: "lazy",
      tools: buildToolSet({ tools: harnessTools }),
    });
    const description = applied.modelTools[CODE_MODE_TOOL_NAME]?.description ?? "";
    expect(description).toContain("Available tools: add, code_mode.");
    expect(description).toContain(SEARCH_TOOLS_NAME);
    expect(description).toContain(DESCRIBE_TOOLS_NAME);
    expect(description).toContain('"names"');
    expect(description).toContain('"query"');
    expect(description).toContain("substring");
    expect(description).not.toContain('"q"');
    expect(Object.keys(applied.modelTools)).toEqual([CODE_MODE_TOOL_NAME]);
    expect(description).not.toContain("Prefer direct tools");
  });

  it("keeps code_mode available for discovery when nothing is claimable", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["gated", tool("gated", { approval: always() })],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);
    const applied = await applyCodeModeTool({
      continuationSecurity,
      harnessTools,
      mode: "eager",
      tools: buildToolSet({ tools: harnessTools }),
    });
    expect(applied.claimedToolNames).toEqual([]);
    expect(applied.harnessTools.has(CODE_MODE_TOOL_NAME)).toBe(true);
    expect(Object.keys(applied.modelTools)).toEqual(["gated", "code_mode"]);
  });

  it.each(["eager", "lazy"] as const)(
    "pins every advertised tool for discovery in %s mode",
    async (mode) => {
      const harnessTools = new Map<string, HarnessToolDefinition>([
        ["add", tool("add")],
        ["gated", tool("gated", { approval: always() })],
        ["background", tool("background", { execution: "background" })],
        ["provider", tool("provider", { execute: undefined })],
        ["connection_search", tool("connection_search")],
        ["task_cancel", tool("task_cancel", { runtimeAction: { kind: "task-control" } })],
        ["hidden", tool("hidden")],
        [CODE_MODE_TOOL_NAME, codeModeDefinition()],
      ]);
      const tools = buildToolSet({ tools: harnessTools });
      delete tools.hidden;
      const applied = await applyCodeModeTool({ continuationSecurity, harnessTools, mode, tools });
      const input = parseCodeModeWorkflowInput(
        applied.harnessTools.get(CODE_MODE_TOOL_NAME)!.executeInput!({ js: "return 1;" }),
      );
      expect(input.toolCatalog.map((entry) => entry.name)).toEqual(Object.keys(tools).sort());
      expect(
        input.toolCatalog.filter((entry) => !entry.requiresDirectCall).map((entry) => entry.name),
      ).toEqual(["add"]);
      expect(input.toolCatalog.find((entry) => entry.name === "gated")?.inputSchema).toEqual({
        type: "object",
        properties: { q: { type: "string" } },
      });
      expect(applied.claimedToolNames).toEqual(["add"]);
      expect(applied.modelTools.gated).toBeDefined();
      expect(applied.modelTools.background).toBeDefined();
      expect(applied.modelTools.provider).toBeDefined();
      const description = applied.modelTools[CODE_MODE_TOOL_NAME]!.description!;
      expect(description).toContain(
        "search_tools: (input: { query?: string; }) => Promise<{ name: string; description: string; requiresDirectCall: boolean; }[]>;",
      );
      expect(description).toContain(
        'describe_tools: (input: { names: string[]; }) => Promise<Array<{ name: string; description: string; requiresDirectCall: boolean; inputSchema: Record<string, unknown>; } | { name: string; error: "unknown tool"; }>>;',
      );
    },
  );

  it("is a no-op when the agent does not enable code_mode", async () => {
    const harnessTools: HarnessToolMap = new Map([["add", tool("add")]]);
    const tools = buildToolSet({ tools: harnessTools });
    const applied = await applyCodeModeTool({
      continuationSecurity,
      harnessTools,
      mode: "eager",
      tools,
    });
    expect(applied.modelTools).toBe(tools);
    expect(applied.harnessTools).toBe(harnessTools);
  });
});

describe("createDiscoveryTools", () => {
  const entry = {
    name: "add",
    description: "Add numbers.",
    inputSchema: { type: "object" },
    requiresDirectCall: false,
  };
  const tools = createDiscoveryTools([entry]);

  it("declares the array returned by search, including no matches", async () => {
    const search = tools[SEARCH_TOOLS_NAME];
    const result = await search.execute({});
    expect(result).toEqual([
      { name: "add", description: "Add numbers.", requiresDirectCall: false },
    ]);
    expect(await asSchema(search.outputSchema).validate!(result)).toMatchObject({
      success: true,
      value: result,
    });

    const empty = await search.execute({ query: "missing" });
    expect(empty).toEqual([]);
    expect(await asSchema(search.outputSchema).validate!(empty)).toMatchObject({
      success: true,
      value: [],
    });
  });

  it("declares both known-tool descriptions and unknown-tool errors", async () => {
    const describe = tools[DESCRIBE_TOOLS_NAME];
    const result = await describe.execute({ names: ["add", "missing"] });
    expect(result).toEqual([entry, { name: "missing", error: "unknown tool" }]);
    expect(await asSchema(describe.outputSchema).validate!(result)).toMatchObject({
      success: true,
      value: result,
    });
  });
});
