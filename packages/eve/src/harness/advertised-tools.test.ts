import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { getAdvertisedTools } from "#harness/advertised-tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import { buildToolSet } from "#harness/tools.js";

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

  it("does not add Workflow in runtime subagent sessions", async () => {
    const tools = new Map([["delegate", createSubagentTool("delegate")]]) satisfies HarnessToolMap;

    const advertisedTools = await getAdvertisedTools({
      modelTools: buildToolSet({ tools }),
      session: createSession({ rootSessionId: "root-session" }),
      tools,
      codeMode: { mode: "eager" },
    });

    expect(Object.keys(advertisedTools.modelTools)).toEqual(["delegate"]);
    expect(advertisedTools.modelTools["Workflow"]).toBeUndefined();
  });

  it("does not add the removed Workflow wrapper in root sessions", async () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["delegate", createSubagentTool("delegate")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = await getAdvertisedTools({
      modelTools: buildToolSet({ tools }),
      session: createSession(),
      tools,
      codeMode: { mode: "eager" },
    });

    expect([...advertisedTools.harnessTools.keys()]).toEqual(["add", "delegate"]);
    expect(advertisedTools.modelTools["Workflow"]).toBeUndefined();
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

  it("keeps the task tools in the root session", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["task_cancel", createTaskControlTool("task_cancel", ["root-session"])],
      ["task_update", createTaskControlTool("task_update", ["delegated-task-child"])],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({ session: {}, tools });

    expect([...advertisedTools.keys()]).toEqual(["add", "task_cancel"]);
  });

  it("exposes delegated-task-child tools from persisted session ownership", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["task_cancel", createTaskControlTool("task_cancel", ["root-session"])],
      ["task_update", createTaskControlTool("task_update", ["delegated-task-child"])],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { rootSessionId: "root-session", taskId: "task-1" },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add", "task_update"]);
  });

  it("removes task_update from sessions without task ownership", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["task_update", createTaskControlTool("task_update", ["delegated-task-child"])],
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

function createTaskControlTool(
  name: string,
  availability: NonNullable<HarnessToolDefinition["behavior"]>["availability"],
): HarnessToolDefinition {
  return {
    ...createTool(name),
    behavior: { availability },
    runtimeAction: { kind: "task-control" },
  };
}

function createSession(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "test-session",
    ...overrides,
  };
}
