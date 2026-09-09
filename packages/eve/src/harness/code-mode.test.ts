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
import {
  DEFAULT_CODE_MODE_MAX_SUBAGENTS,
  parseCodeModeWorkflowInput,
} from "#execution/code-mode/schema.js";
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

/** Authored `defineWorkflowTool` as the node step registers it: no direct executor. */
function workflowTool(
  name: string,
  extra: Partial<HarnessToolDefinition> = {},
): HarnessToolDefinition {
  return tool(name, {
    behavior: {
      availability: [],
      handling: {
        kind: "dispatch",
        target: { kind: "workflow-tool-call", workflowId: `workflow//app//${name}` },
      },
    },
    execute: undefined,
    workflowId: `workflow//app//${name}`,
    ...extra,
  });
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
      ["authored_wf", workflowTool("authored_wf")],
      ["background_wf", workflowTool("background_wf", { execution: "background" })],
      ["gated_wf", workflowTool("gated_wf", { approval: always() })],
      ["pinned_wf", workflowTool("pinned_wf", { executeInput: () => ({ pinned: true }) })],
      ["task_cancel", tool("task_cancel", { runtimeAction: { kind: "task-control" } })],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);

    const claimed = [...tools.keys()].filter((name) => claimsForCodeMode(name, tools));
    expect(claimed).toEqual(["add", "researcher", "agent", "authored_wf", "background_wf"]);
  });

  it("claims the framework question tool while other handled tools stay direct", () => {
    const question = (
      handling: NonNullable<HarnessToolDefinition["behavior"]>["handling"],
    ): HarnessToolDefinition =>
      tool("ask_question", {
        behavior: { availability: ["requires-request-input"], handling },
        execute: undefined,
      });
    const dispatch = { kind: "dispatch", target: { kind: "task-cancel" } } as const;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["ask_question", question({ kind: "request-input", request: "question" })],
      ["task_cancel", tool("task_cancel", { behavior: { availability: [], handling: dispatch } })],
    ]);

    expect(claimsForCodeMode("ask_question", tools)).toBe(true);
    expect(claimsForCodeMode("task_cancel", tools)).toBe(false);
    expect(claimsForCodeMode("ask_question", new Map([["ask_question", question(dispatch)]]))).toBe(
      false,
    );
  });
});

describe("applyCodeModeTool", () => {
  it.each([false, true])(
    "preserves direct workspace tools (approval required=%s)",
    async (gated) => {
      const harnessTools = new Map<string, HarnessToolDefinition>([
        ...["bash", "read_file", "write_file", "todo", "glob", "grep", "renamed_shell"].map(
          (name) => [name, tool(name, gated ? { approval: always() } : {})] as const,
        ),
        ["remote_lookup", tool("remote_lookup", { dynamic: true })],
        [CODE_MODE_TOOL_NAME, codeModeDefinition()],
      ]);
      const tools = buildToolSet({ tools: harnessTools });
      const applied = await applyCodeModeTool({ continuationSecurity, harnessTools, tools });
      expect(Object.keys(applied.modelTools)).toEqual([
        "bash",
        "read_file",
        "write_file",
        "todo",
        "glob",
        "grep",
        "renamed_shell",
        CODE_MODE_TOOL_NAME,
      ]);
      expect(applied.modelTools.bash).toBe(tools.bash);
      expect(applied.modelTools.read_file).toBe(tools.read_file);
      const input = parseCodeModeWorkflowInput(
        applied.harnessTools.get(CODE_MODE_TOOL_NAME)!.executeInput!({ js: "return 1;" }),
      );
      expect(input.toolCatalog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "bash", target: gated ? "direct" : "tool" }),
          expect.objectContaining({ name: "read_file", target: gated ? "direct" : "tool" }),
          expect.objectContaining({ name: "remote_lookup", target: "tool" }),
        ]),
      );
    },
  );

  it("pins the default subagent budget", async () => {
    const harnessTools = new Map([[CODE_MODE_TOOL_NAME, codeModeDefinition()]]);
    const applied = await applyCodeModeTool({
      continuationSecurity,
      harnessTools,
      tools: buildToolSet({ tools: harnessTools }),
    });
    const input = applied.harnessTools.get(CODE_MODE_TOOL_NAME)!.executeInput!({
      js: "return null;",
    });
    expect(parseCodeModeWorkflowInput(JSON.parse(JSON.stringify(input))).maxSubagents).toBe(
      DEFAULT_CODE_MODE_MAX_SUBAGENTS,
    );
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain(
      `at most ${DEFAULT_CODE_MODE_MAX_SUBAGENTS} subagents`,
    );
    expect(codeModeBridgeRequestLimit(DEFAULT_CODE_MODE_MAX_SUBAGENTS)).toBeGreaterThan(
      DEFAULT_CODE_MODE_MAX_SUBAGENTS,
    );
  });

  it("describes subagents as awaited results inside programs and receipts outside", async () => {
    const agent = {
      ...subagent("researcher"),
      description:
        "Research releases. This call starts a background task and returns a task receipt immediately.",
      outputSchema: jsonSchema({ type: "object", properties: { taskId: { type: "string" } } }),
    };
    const harnessTools = new Map([
      ["researcher", agent],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);
    const tools = buildToolSet({ tools: harnessTools });
    const applied = await applyCodeModeTool({ continuationSecurity, harnessTools, tools });
    const input = parseCodeModeWorkflowInput(
      applied.harnessTools.get(CODE_MODE_TOOL_NAME)!.executeInput!({ js: "return null;" }),
    );
    const entry = input.toolCatalog.find((entry) => entry.name === "researcher")!;
    expect(entry.description).toContain("Research releases.");
    expect(entry.description).toContain("child's final response");
    expect(entry.description).not.toContain("returns a task receipt immediately");
    expect(entry.outputSchema).toBeNull();
    expect(applied.modelTools.researcher).toBe(tools.researcher);
    expect(applied.modelTools.researcher?.description).toContain(
      "returns a task receipt immediately",
    );
  });

  it("keeps authored tools direct and pins the program catalog into executeInput", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["add", tool("add", { outputSchema: jsonSchema({ type: "number" }) })],
      ["gated", tool("gated", { approval: always() })],
      ["researcher", subagent("researcher")],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);
    const tools = buildToolSet({ tools: harnessTools });
    const applied = await applyCodeModeTool({
      continuationSecurity,
      harnessTools,

      tools,
    });

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
      "Use direct tools for simple operations.",
    );
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).not.toContain(
      "Prefer direct tools",
    );
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.execute).toBeUndefined();
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain("add");
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain("researcher");

    const definition = applied.harnessTools.get(CODE_MODE_TOOL_NAME);
    expect(definition?.workflowId).toBe(codeModeWorkflowReference.workflowId);
    const executeInput = definition?.executeInput?.({ js: "return 1;" });
    expect(parseCodeModeWorkflowInput(executeInput)).toMatchObject({
      js: "return 1;",

      toolCatalog: expect.arrayContaining([
        expect.objectContaining({ name: "add", target: "tool", outputSchema: { type: "number" } }),
        expect.objectContaining({ name: "researcher", target: "agent" }),
        expect.objectContaining({ name: "gated", target: "direct" }),
      ]),
    });
  });

  it("lists names only and advertises discovery helpers", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["add", tool("add")],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);
    const applied = await applyCodeModeTool({
      continuationSecurity,
      harnessTools,

      tools: buildToolSet({ tools: harnessTools }),
    });
    const description = applied.modelTools[CODE_MODE_TOOL_NAME]?.description ?? "";
    expect(description).toContain("Available tools: add, code_mode.");
    expect(description).toContain(SEARCH_TOOLS_NAME);
    expect(description).toContain(DESCRIBE_TOOLS_NAME);
    expect(description).toContain('"names"');
    expect(description).toContain('"query"');
    expect(description).toContain("Matches any keyword");
    expect(description).toContain("call connection_search directly");
    expect(description).toContain("then start a new program");
    expect(description).not.toContain('"q"');
    expect(Object.keys(applied.modelTools)).toEqual(["add", CODE_MODE_TOOL_NAME]);
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

      tools: buildToolSet({ tools: harnessTools }),
    });
    expect(applied.harnessTools.has(CODE_MODE_TOOL_NAME)).toBe(true);
    expect(Object.keys(applied.modelTools)).toEqual(["gated", "code_mode"]);
  });

  it("pins every advertised tool for discovery", async () => {
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
    const applied = await applyCodeModeTool({ continuationSecurity, harnessTools, tools });
    const input = parseCodeModeWorkflowInput(
      applied.harnessTools.get(CODE_MODE_TOOL_NAME)!.executeInput!({ js: "return 1;" }),
    );
    expect(input.toolCatalog.map((entry) => entry.name)).toEqual(Object.keys(tools).sort());
    expect(
      input.toolCatalog.filter((entry) => entry.target !== "direct").map((entry) => entry.name),
    ).toEqual(["add"]);
    expect(input.toolCatalog.find((entry) => entry.name === "gated")?.inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
    expect(Object.keys(applied.modelTools)).toEqual([
      "add",
      "gated",
      "background",
      "provider",
      "connection_search",
      "task_cancel",
      CODE_MODE_TOOL_NAME,
    ]);
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
  });

  it("pins authored workflow tools as workflow targets while keeping them direct", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["plan", workflowTool("plan", { outputSchema: jsonSchema({ type: "string" }) })],
      ["pinned", workflowTool("pinned", { executeInput: () => ({ pinned: true }) })],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);
    const tools = buildToolSet({ tools: harnessTools });
    const applied = await applyCodeModeTool({ continuationSecurity, harnessTools, tools });

    expect(Object.keys(applied.modelTools)).toEqual(["plan", "pinned", CODE_MODE_TOOL_NAME]);
    expect(applied.modelTools.plan).toBe(tools.plan);
    const serialized = applied.harnessTools.get(CODE_MODE_TOOL_NAME)!.executeInput!({
      js: "return 1;",
    });
    const input = parseCodeModeWorkflowInput(JSON.parse(JSON.stringify(serialized)));
    expect(input.toolCatalog.find((entry) => entry.name === "plan")).toEqual({
      name: "plan",
      description: "Tool plan.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      outputSchema: { type: "string" },
      target: "workflow",
      workflowId: "workflow//app//plan",
    });
    expect(input.toolCatalog.find((entry) => entry.name === "pinned")).toEqual(
      expect.objectContaining({ target: "direct" }),
    );
    expect(input.toolCatalog.find((entry) => entry.name === "pinned")).not.toHaveProperty(
      "workflowId",
    );
  });

  it("is a no-op when the agent does not enable code_mode", async () => {
    const harnessTools: HarnessToolMap = new Map([["add", tool("add")]]);
    const tools = buildToolSet({ tools: harnessTools });
    const applied = await applyCodeModeTool({
      continuationSecurity,
      harnessTools,

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
    outputSchema: null,
    target: "tool" as const,
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

  it("ranks individual keywords across names and descriptions without requiring the whole phrase", async () => {
    const search = createDiscoveryTools([
      { ...entry, name: "venmo__login", description: "Login to your account." },
      { ...entry, name: "simple_note__login", description: "Login to your account." },
      { ...entry, name: "simple_note__listNotes", description: "List notes." },
      { ...entry, name: "unrelated", description: "Add numbers." },
    ])[SEARCH_TOOLS_NAME];
    const names = async (query: string) =>
      (await search.execute({ query })).map((tool) => tool.name);

    expect(await names("login authenticate access token simple note venmo")).toEqual([
      "simple_note__login",
      "simple_note__listNotes",
      "venmo__login",
    ]);
    expect(await names("VENMO login login")).toEqual(["venmo__login", "simple_note__login"]);
    expect(await names("simple-note/listNotes")).toEqual([
      "simple_note__listNotes",
      "simple_note__login",
    ]);
    expect(await names("LOGIN missing")).toEqual(["venmo__login", "simple_note__login"]);
    expect(await names("missing")).toEqual([]);
    expect(await names("   ")).toEqual([
      "venmo__login",
      "simple_note__login",
      "simple_note__listNotes",
      "unrelated",
    ]);
  });

  it("weights name matches above description matches using connection search ranking", async () => {
    const search = createDiscoveryTools([
      { ...entry, name: "description_match", description: "Login authenticate." },
      { ...entry, name: "login", description: "Access your account." },
    ])[SEARCH_TOOLS_NAME];
    expect(
      (await search.execute({ query: "login authenticate" })).map((tool) => tool.name),
    ).toEqual(["login", "description_match"]);
    expect(await search.execute({ query: "a" })).toEqual([]);
  });

  it("does not mistake a missing connection tool for a loaded one", async () => {
    const search = createDiscoveryTools([
      { ...entry, name: "connection_search", description: "Search connections.", target: "direct" },
    ])[SEARCH_TOOLS_NAME];
    expect(await search.execute({ query: "venmo login" })).toEqual([]);
    expect(search.description).toContain("Undiscovered connection tools are excluded");
    expect(search.description).toContain("call connection_search directly");
  });

  it("declares both known-tool descriptions and unknown-tool errors", async () => {
    const describe = tools[DESCRIBE_TOOLS_NAME];
    const result = await describe.execute({ names: ["add", "missing"] });
    expect(result).toEqual([
      {
        name: "add",
        description: "Add numbers.",
        inputSchema: { type: "object" },
        requiresDirectCall: false,
      },
      { name: "missing", error: "unknown tool" },
    ]);
    expect(await asSchema(describe.outputSchema).validate!(result)).toMatchObject({
      success: true,
      value: result,
    });
  });
});
