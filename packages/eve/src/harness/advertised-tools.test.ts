import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { getAdvertisedTools } from "#harness/advertised-tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";

describe("getAdvertisedTools", () => {
  it("keeps the built-in agent tool in the root session", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["agent", createBuiltInAgentTool()],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({ session: {}, tools });

    expect([...advertisedTools.keys()]).toEqual(["add", "agent"]);
  });

  it("keeps declared subagent tools in delegated sessions", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["delegate", createSubagentTool("delegate")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { rootSessionId: "root-session" },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add", "delegate"]);
  });

  it("removes the built-in agent tool from delegated sessions", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["agent", createBuiltInAgentTool()],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { rootSessionId: "root-session" },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add"]);
  });

  it("keeps a declared subagent named agent in delegated sessions", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["agent", createSubagentTool("agent")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { rootSessionId: "root-session" },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add", "agent"]);
  });
});

describe("getAdvertisedTools for definition arrays", () => {
  it("removes built-in agent tool definitions from delegated sessions", () => {
    const advertisedTools = getAdvertisedTools({
      session: { rootSessionId: "root-session" },
      tools: [createTool("add"), createSubagentTool("delegate"), createBuiltInAgentTool()],
    });

    expect(advertisedTools.map((tool) => tool.name)).toEqual(["add", "delegate"]);
  });

  it("hides tools marked unavailable in subagents from delegated sessions", () => {
    const tools = new Map([
      ["root_only", { ...createTool("root_only"), availableInSubagents: false }],
    ]) satisfies HarnessToolMap;

    expect([...getAdvertisedTools({ session: {}, tools }).keys()]).toEqual(["root_only"]);
    expect([
      ...getAdvertisedTools({ session: { rootSessionId: "root-session" }, tools }).keys(),
    ]).toEqual([]);
  });

  it("keeps root-session tools in the root session", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["root_only", createAvailableTool("root_only", ["root-session"])],
      ["child_only", createAvailableTool("child_only", ["delegated-task-child"])],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({ session: {}, tools });

    expect([...advertisedTools.keys()]).toEqual(["add", "root_only"]);
  });

  it("exposes delegated-task-child tools from persisted session ownership", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["root_only", createAvailableTool("root_only", ["root-session"])],
      ["child_only", createAvailableTool("child_only", ["delegated-task-child"])],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { rootSessionId: "root-session", taskId: "task-1" },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add", "child_only"]);
  });

  it.each([{}, { rootSessionId: "root-session" }])(
    "removes delegated-task-child tools from sessions without task ownership (%j)",
    (session) => {
      const tools = new Map([
        ["add", createTool("add")],
        ["child_only", createAvailableTool("child_only", ["delegated-task-child"])],
      ]) satisfies HarnessToolMap;

      const advertisedTools = getAdvertisedTools({ session, tools });

      expect([...advertisedTools.keys()]).toEqual(["add"]);
    },
  );
});

function createTool(name: string): HarnessToolDefinition {
  return {
    description: `${name} description`,
    inputSchema: jsonSchema({ type: "object" }),
    name,
  };
}

function createSubagentTool(name: string): HarnessToolDefinition {
  return {
    ...createTool(name),
    resultKind: "subagent",
    workflowId: "workflow//./agent/subagents/researcher//execute",
  };
}

function createBuiltInAgentTool(): HarnessToolDefinition {
  return {
    ...createSubagentTool("agent"),
    rootOnly: true,
  };
}

function createAvailableTool(
  name: string,
  availability: NonNullable<HarnessToolDefinition["behavior"]>["availability"],
): HarnessToolDefinition {
  return {
    ...createTool(name),
    behavior: { availability },
  };
}
