import { describe, expect, it } from "vitest";

import {
  beforeModelCall,
  evaluationError,
  reactionSession,
} from "#internal/testing/reaction-session.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineTool } from "#tools/definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { dynamicTools } from "./tool.js";

const tool = (description = "Search issues.") =>
  defineTool({ description, execute: async () => null, inputSchema: {} });

const toolNames = async (source: Parameters<typeof reactionSession>[0]) => {
  const { ctx } = reactionSession(source);
  await beforeModelCall(ctx);
  return dynamicTools(ctx).map(({ name }) => name);
};

describe("dynamic tools", () => {
  it.each([
    ["names one tool after its file", undefined, () => tool(), ["search"]],
    [
      "names a map's tools after their keys",
      undefined,
      () => ({ close: tool(), open: tool() }),
      ["close", "open"],
    ],
    [
      "prefixes an extension's map keys with its namespace",
      "tracker",
      () => ({ search: tool() }),
      ["tracker__search"],
    ],
    ["offers nothing for null", undefined, () => null, []],
  ])("%s", async (_name, extensionNamespace, evaluate, expected) => {
    expect(await toolNames({ tools: [{ evaluate, extensionNamespace, slug: "search" }] })).toEqual(
      expected,
    );
  });

  it.each([
    [
      "an entry without defineTool()",
      () => ({ search: { description: "Search." } }),
      {},
      "without defineTool()",
    ],
    ["an illegal name", () => ({ "Search!": tool() }), {}, 'illegal tool name "Search!"'],
    ["eve's namespace", () => ({ eve__search: tool() }), {}, 'reserved tool name "eve__search"'],
    [
      "a workflow tool",
      () =>
        defineWorkflowTool({
          description: "Deploy.",
          execute: async () => null,
          inputSchema: {},
        }),
      {},
      "cannot return defineWorkflowTool()",
    ],
    [
      "an authored workflow tool's name",
      () => tool(),
      { toolNames: [{ name: "search", workflow: true as const }] },
      'collides with the workflow tool or agent "search"',
    ],
    [
      "a name a connection owns",
      () => ({ linear__search: tool() }),
      {
        connections: [
          {
            evaluate: () =>
              defineMcpClientConnection({ description: "Linear.", url: "https://linear.example" }),
            slug: "linear",
          },
        ],
      },
      'starts with "linear__"',
    ],
  ])("rejects %s", async (_name, evaluate, session, message) => {
    const { ctx } = reactionSession({ ...session, tools: [{ evaluate, slug: "search" }] });
    expect(await evaluationError(ctx)).toContain(message);
  });

  it("keeps the first definition's tool when two return the same name, and logs the other", async () => {
    const logs = captureLogRecords();
    const { ctx } = reactionSession({
      tools: [
        { evaluate: () => ({ search: tool("First.") }), slug: "first" },
        { evaluate: () => ({ search: tool("Second.") }), slug: "second" },
      ],
    });
    await beforeModelCall(ctx);

    expect(dynamicTools(ctx).map(({ description }) => description)).toEqual(["First."]);
    expect(logs.records.map(({ message }) => message)).toContain(
      'Dynamic tool "search" from "tool::second" collides with another dynamic tool.',
    );
  });
});
