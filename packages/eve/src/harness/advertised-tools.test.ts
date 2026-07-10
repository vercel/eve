import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { getAdvertisedTools } from "#harness/advertised-tools.js";
import { DEFAULT_SUBAGENT_MAX_DEPTH } from "#harness/subagent-depth.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import { buildToolSet } from "#harness/tools.js";
import { WORKFLOW_TOOL_NAME } from "#shared/workflow-sandbox.js";

describe("getAdvertisedTools", () => {
  it("keeps subagent tools below the subagent depth limit", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["delegate", createSubagentTool("delegate")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { subagentDepth: DEFAULT_SUBAGENT_MAX_DEPTH - 1 },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add", "delegate"]);
  });

  it("removes subagent tools at the subagent depth limit", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["delegate", createSubagentTool("delegate")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { subagentDepth: DEFAULT_SUBAGENT_MAX_DEPTH },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add"]);
  });

  it("removes the built-in agent tool at the subagent depth limit", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["agent", createSubagentTool("agent")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { subagentDepth: DEFAULT_SUBAGENT_MAX_DEPTH },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add"]);
  });

  it("uses the session-specific subagent max depth when configured", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["delegate", createSubagentTool("delegate")],
    ]) satisfies HarnessToolMap;
    const maxDepth = DEFAULT_SUBAGENT_MAX_DEPTH + 1;

    const belowCustomLimit = getAdvertisedTools({
      session: { subagentDepth: DEFAULT_SUBAGENT_MAX_DEPTH, subagentMaxDepth: maxDepth },
      tools,
    });
    const atCustomLimit = getAdvertisedTools({
      session: { subagentDepth: maxDepth, subagentMaxDepth: maxDepth },
      tools,
    });

    expect([...belowCustomLimit.keys()]).toEqual(["add", "delegate"]);
    expect([...atCustomLimit.keys()]).toEqual(["add"]);
  });

  it("keeps direct subagent tools in runtime subagent sessions below the depth limit", () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["delegate", createSubagentTool("delegate")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = getAdvertisedTools({
      session: { rootSessionId: "root-session", subagentDepth: 1, subagentMaxDepth: 2 },
      tools,
    });

    expect([...advertisedTools.keys()]).toEqual(["add", "delegate"]);
  });

  it("does not add Workflow in runtime subagent sessions", async () => {
    const tools = new Map([["delegate", createSubagentTool("delegate")]]) satisfies HarnessToolMap;

    const advertisedTools = await getAdvertisedTools({
      modelTools: buildToolSet({ tools }),
      session: createSession({ rootSessionId: "root-session", subagentDepth: 1 }),
      tools,
      workflow: {},
    });

    expect(Object.keys(advertisedTools.modelTools)).toEqual(["delegate"]);
    expect(advertisedTools.modelTools[WORKFLOW_TOOL_NAME]).toBeUndefined();
  });

  it("adds Workflow in root sessions below the depth limit", async () => {
    const tools = new Map([
      ["add", createTool("add")],
      ["delegate", createSubagentTool("delegate")],
    ]) satisfies HarnessToolMap;

    const advertisedTools = await getAdvertisedTools({
      modelTools: buildToolSet({ tools }),
      session: createSession(),
      tools,
      workflow: {},
    });

    expect([...advertisedTools.harnessTools.keys()]).toEqual(["add", "delegate"]);
    expect(advertisedTools.modelTools[WORKFLOW_TOOL_NAME]).toBeDefined();
  });
});

describe("getAdvertisedTools for definition arrays", () => {
  it("removes subagent tool definitions at the subagent depth limit", () => {
    const advertisedTools = getAdvertisedTools({
      session: { subagentDepth: DEFAULT_SUBAGENT_MAX_DEPTH },
      tools: [createTool("add"), createSubagentTool("delegate")],
    });

    expect(advertisedTools.map((tool) => tool.name)).toEqual(["add"]);
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
