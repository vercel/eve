import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { getAdvertisedTools } from "#harness/advertised-tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";

describe("getAdvertisedTools", () => {
  it("keeps the built-in agent tool in the root session", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["agent", createBuiltInAgentTool()],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({ session: {}, tools });

    expect([...advertisedTools.keys()]).toEqual(["add", "agent"]);
  });

  it("keeps declared subagent tools at any subagent depth", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["delegate", createSubagentTool("delegate")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { subagentDepth: 99 },
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
      session: { rootSessionId: "root-session", subagentDepth: 1 },
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
      session: { rootSessionId: "root-session", subagentDepth: 1 },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add", "agent"]);
  });

  it("removes the built-in agent tool when depth identifies a delegated session", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["agent", createBuiltInAgentTool()],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { subagentDepth: 1 },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add"]);
  });

  it("keeps declared subagent tools in runtime subagent sessions", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["delegate", createSubagentTool("delegate")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: {
        rootSessionId: "root-session",
        subagentDepth: 99,
      },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add", "delegate"]);
  });
});

describe("getAdvertisedTools for definition arrays", () => {
  it("removes built-in agent tool definitions from delegated sessions", () => {
    const advertisedTools = getAdvertisedTools({
      session: { rootSessionId: "root-session", subagentDepth: 1 },
      tools: [createTool("add"), createSubagentTool("delegate"), createBuiltInAgentTool()],
    });

    expect(advertisedTools.map((tool) => tool.name)).toEqual(["add", "delegate"]);
  });

  it("keeps the task tools in the root session", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["task_cancel", createTaskControlTool("task_cancel")],
      ["task_update", createTaskControlTool("task_update")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({ session: {}, tools });

    expect([...advertisedTools.keys()]).toEqual(["add", "task_cancel"]);
  });

  it("keeps only task_update in delegated sessions", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["task_cancel", createTaskControlTool("task_cancel")],
      ["task_update", createTaskControlTool("task_update")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      delegatedCaller: true,
      session: { rootSessionId: "root-session", subagentDepth: 1 },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add", "task_update"]);
  });

  it("removes task_update from sessions without a delegated caller", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["task_update", createTaskControlTool("task_update")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({ session: {}, tools });

    expect([...advertisedTools.keys()]).toEqual(["add"]);
  });
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
    runtimeAction: {
      kind: "subagent-call",
      nodeId: "workers",
      subagentName: name,
    },
  };
}

function createBuiltInAgentTool(): HarnessToolDefinition {
  return {
    ...createSubagentTool("agent"),
    runtimeAction: {
      kind: "subagent-call",
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      subagentName: "agent",
    },
  };
}

function createTaskControlTool(name: string): HarnessToolDefinition {
  return {
    ...createTool(name),
    runtimeAction: { kind: "task-control" },
  };
}
