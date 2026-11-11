import { describe, expect, it } from "vitest";

import {
  beforeModelCall,
  dynamicTools,
  evaluationError,
  definitionSession,
} from "#internal/testing/definition-session.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineTool } from "#tools/definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { agent } from "#public/tools/agent.js";
import { nativeCatalog } from "#internal/testing/catalog-fixtures.js";

const tool = (description = "Search issues.") =>
  defineTool({ description, execute: async () => null, inputSchema: {} });

const toolNames = async (source: Parameters<typeof definitionSession>[0]) => {
  const { ctx } = definitionSession(source);
  await beforeModelCall(ctx);
  return (await dynamicTools(ctx)).map(({ name }) => name);
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
      "a workflow tool whose entry point the build didn't compile",
      () =>
        defineWorkflowTool({
          description: "Deploy.",
          execute: async () => null,
          inputSchema: {},
        }),
      {},
      `returned workflow tool "search" whose entry point isn't a compiled workflow`,
    ],
    [
      "eve's built-in agent({ models }) tool",
      () => agent({ models: { "openai/gpt-5.4": "Hard tasks" } }),
      {},
      `returned eve's built-in workflow tool "search", which only works as a static tool`,
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
    const { ctx } = definitionSession({ ...session, tools: [{ evaluate, slug: "search" }] });
    expect(await evaluationError(ctx)).toContain(message);
  });

  it("runs a returned workflow tool from its compiled workflow", async () => {
    const execute = Object.assign(async () => null, {
      workflowId: "workflow//./tools/deploy//deploy",
    });
    const { ctx } = definitionSession({
      tools: [
        {
          evaluate: () => ({
            deploy: defineWorkflowTool({ description: "Deploy.", execute, inputSchema: {} }),
          }),
          slug: "deploy",
        },
      ],
    });
    await beforeModelCall(ctx);

    const [deploy] = await dynamicTools(ctx);
    expect(deploy).toMatchObject({
      behavior: {
        handling: {
          kind: "dispatch",
          target: {
            entryPoint: "execute",
            kind: "workflow-tool-call",
            workflowId: "workflow//./tools/deploy//deploy",
          },
        },
      },
      execute: undefined,
      name: "deploy",
      workflowId: "workflow//./tools/deploy//deploy",
    });
  });

  it("takes a name a dynamic connection gives up in the same call", async () => {
    let moved = false;
    const { ctx } = definitionSession({
      connections: [
        {
          evaluate: () => ({
            [moved ? "jira" : "linear"]: defineMcpClientConnection({
              description: "Issues.",
              url: "https://issues.example",
            }),
          }),
          slug: "issues",
        },
      ],
      tools: [{ evaluate: () => (moved ? { linear__search: tool() } : null), slug: "search" }],
    });
    await beforeModelCall(ctx);
    moved = true;
    await beforeModelCall(ctx);

    expect((await dynamicTools(ctx)).map(({ name }) => name)).toEqual(["linear__search"]);
  });

  it("rejects a tool map name longer than 64 characters after namespacing", async () => {
    const extensionNamespace = "a".repeat(40);
    const key = "b".repeat(30);
    const { ctx } = definitionSession({
      tools: [
        {
          evaluate: () => ({ [key]: tool() }),
          extensionNamespace,
          slug: `${extensionNamespace}__search`,
        },
      ],
    });

    expect(await evaluationError(ctx)).toContain(
      `illegal tool name "${extensionNamespace}__${key}"`,
    );
  });

  it("keeps the first definition's tool when two return the same name, and logs the other", async () => {
    const logs = captureLogRecords();
    const { ctx } = definitionSession({
      tools: [
        { evaluate: () => ({ search: tool("First.") }), slug: "first" },
        { evaluate: () => ({ search: tool("Second.") }), slug: "second" },
      ],
    });
    await beforeModelCall(ctx);
    const catalog = await nativeCatalog({
      agentTools: new Map(),
      ctx,
      endsTurn: false,
      session: {},
    });

    expect(catalog.get("search")?.description).toBe("First.");
    expect(logs.records.map(({ message }) => message)).toContain(
      'Tool "search" from "tool::second" collides with the one from "tool::first"; the first keeps it.',
    );
  });
});
