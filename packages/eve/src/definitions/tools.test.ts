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
import { nativeCatalog } from "#internal/testing/catalog-fixtures.js";
import { contextStorage, type ContextContainer } from "#context/container.js";
import { evaluateStepValues } from "#definitions/step.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { toInputSchema } from "#tools/schema.js";

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
      "a tool with enabled",
      () => defineTool({ ...tool(), enabled: () => true }),
      {},
      'returned a tool with "enabled"',
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

describe("static tools", () => {
  const staticTool = (
    name: string,
    enabled?: HarnessToolDefinition["enabled"],
  ): HarnessToolDefinition => ({
    description: `${name}.`,
    inputSchema: toInputSchema({ type: "object" }),
    name,
    ...(enabled !== undefined && { enabled }),
  });

  const offered = async (ctx: ContextContainer, agentTools: readonly HarnessToolDefinition[]) => {
    const catalog = await nativeCatalog({
      agentTools: new Map(agentTools.map((definition) => [definition.name, definition])),
      ctx,
      endsTurn: false,
      session: {},
    });
    return [...catalog.advertised.keys()].filter((name) =>
      agentTools.some((definition) => definition.name === name),
    );
  };

  const evaluate = (ctx: ContextContainer, agentTools: readonly HarnessToolDefinition[]) =>
    contextStorage.run(ctx, () =>
      evaluateStepValues(
        {
          config: { tools: new Map(agentTools.map((definition) => [definition.name, definition])) },
          ctx,
          finalReplyOnly: false,
          session: { rootSessionId: "" },
        },
        { conversation: [] },
      ),
    );

  it("offers a tool only on the calls its enabled allows", async () => {
    let allowed = false;
    const tools = [staticTool("search"), staticTool("deploy", () => allowed)];
    const { ctx } = definitionSession();

    await evaluate(ctx, tools);
    expect(await offered(ctx, tools)).toEqual(["search"]);

    allowed = true;
    await evaluate(ctx, tools);
    expect(await offered(ctx, tools)).toEqual(["search", "deploy"]);
  });

  it("reads what the latest model call's evaluation decided until the next one", async () => {
    let allowed = true;
    const tools = [staticTool("deploy", () => allowed)];
    const { ctx } = definitionSession();

    await evaluate(ctx, tools);
    allowed = false;

    expect(await offered(ctx, tools)).toEqual(["deploy"]);
  });

  it("decides from the dynamic context", async () => {
    const tools = [staticTool("deploy", (context) => context.model.id === "openai/gpt-5.4")];
    const { ctx } = definitionSession({ model: { id: "openai/gpt-5.4" } });

    await evaluate(ctx, tools);

    expect(await offered(ctx, tools)).toEqual(["deploy"]);
  });
});
