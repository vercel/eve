import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  CODE_MODE_TOOL_NAME,
  applyCodeModeTool,
  claimsForCodeMode,
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
  it("claims executable, ungated tools and every subagent", () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["add", tool("add")],
      ["gated", tool("gated", { approval: always() })],
      ["skill", tool("skill", { behavior: { availability: [], presentation: "load-skill" } })],
      ["provider", tool("provider", { execute: undefined })],
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
  it("moves claimed tools behind code_mode and pins the catalog into executeInput", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      ["add", tool("add")],
      ["gated", tool("gated", { approval: always() })],
      ["researcher", subagent("researcher")],
      [CODE_MODE_TOOL_NAME, codeModeDefinition()],
    ]);
    const applied = await applyCodeModeTool({
      continuationSecurity,
      harnessTools,
      mode: "eager",
      tools: buildToolSet({ tools: harnessTools }),
    });

    expect(applied.claimedToolNames).toEqual(["add", "researcher"]);
    expect(Object.keys(applied.modelTools).sort()).toEqual([CODE_MODE_TOOL_NAME, "gated"]);
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.execute).toBeUndefined();
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain("add");
    expect(applied.modelTools[CODE_MODE_TOOL_NAME]?.description).toContain("researcher");

    const definition = applied.harnessTools.get(CODE_MODE_TOOL_NAME);
    expect(definition?.workflowId).toBe(codeModeWorkflowReference.workflowId);
    const executeInput = definition?.executeInput?.({ js: "return 1;" });
    expect(parseCodeModeWorkflowInput(executeInput)).toEqual({
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
    expect(description).toContain("Available tools: add.");
    expect(description).toContain(SEARCH_TOOLS_NAME);
    expect(description).toContain(DESCRIBE_TOOLS_NAME);
    expect(description).not.toContain('"q"');
  });

  it("drops code_mode entirely when nothing is claimable", async () => {
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
    expect(applied.harnessTools.has(CODE_MODE_TOOL_NAME)).toBe(false);
    expect(Object.keys(applied.modelTools)).toEqual(["gated"]);
  });

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
