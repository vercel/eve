import { describe, expect, it } from "vitest";

import {
  createConnectionSearchEvents,
  extractDiscoveredTools,
  projectConnectionSearchActivation,
} from "#runtime/framework-tools/connection-search-dynamic.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { getToolActivation } from "#harness/tool-activation.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

describe("extractDiscoveredTools", () => {
  it("extracts tools from raw array output", () => {
    const messages: Msg[] = [
      { role: "user", content: [{ type: "text", text: "search" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: [
              {
                connection: "linear",
                tool: "list_issues",
                qualifiedName: "linear__list_issues",
                description: "List issues",
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
              },
            ],
          },
        ],
      },
    ];

    const result = extractDiscoveredTools(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.qualifiedName).toBe("linear__list_issues");
    expect(result[0]!.connection).toBe("linear");
    expect(result[0]!.tool).toBe("list_issues");
    expect(result[0]!.outputSchema).toEqual({ type: "object" });
  });

  it("extracts tools from ToolResultOutput json wrapper", () => {
    const messages: Msg[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: {
              type: "json",
              value: [
                {
                  connection: "linear",
                  tool: "list_issues",
                  qualifiedName: "linear__list_issues",
                  description: "List issues",
                  inputSchema: { type: "object" },
                },
              ],
            },
          },
        ],
      },
    ];

    const result = extractDiscoveredTools(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.qualifiedName).toBe("linear__list_issues");
  });

  it("extracts tools from an Anthropic content result", () => {
    const output = [
      {
        connection: "linear",
        description: "List issues",
        qualifiedName: "linear__list_issues",
        tool: "list_issues",
      },
    ];
    const messages: Msg[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: {
              type: "content",
              value: [
                { type: "text", text: JSON.stringify(output) },
                {
                  type: "custom",
                  providerOptions: {
                    anthropic: {
                      type: "tool-reference",
                      toolName: "linear__list_issues",
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ];

    expect(extractDiscoveredTools(messages)).toEqual(output);
  });

  it("returns empty for no tool results", () => {
    const messages: Msg[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    expect(extractDiscoveredTools(messages)).toHaveLength(0);
  });

  it("keeps the first definition for a qualified name", () => {
    const messages: Msg[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: [
              {
                connection: "linear",
                tool: "list_issues",
                qualifiedName: "linear__list_issues",
                description: "Old description",
              },
            ],
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "connection_search",
            output: [
              {
                connection: "linear",
                tool: "list_issues",
                qualifiedName: "linear__list_issues",
                description: "New description",
              },
            ],
          },
        ],
      },
    ];

    const result = extractDiscoveredTools(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("Old description");
  });

  it("skips items without tool or qualifiedName", () => {
    const messages: Msg[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: [
              {
                connection: "linear",
                description: "No tool or qualifiedName",
              },
              {
                connection: "linear",
                tool: "list_issues",
                qualifiedName: "linear__list_issues",
                description: "Valid",
              },
            ],
          },
        ],
      },
    ];

    const result = extractDiscoveredTools(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("Valid");
  });
});

describe("projectConnectionSearchActivation", () => {
  it("projects only successful discovered tool definitions", () => {
    expect(
      projectConnectionSearchActivation([
        {
          connection: "linear",
          description: "List issues",
          inputSchema: { properties: { state: { type: "string" } }, type: "object" },
          qualifiedName: "linear__list_issues",
          tool: "list_issues",
        },
        {
          connection: "github",
          description: "GitHub",
          error: "metadata unavailable",
        },
      ]),
    ).toEqual({
      tools: [
        {
          description: "List issues",
          inputSchema: { properties: { state: { type: "string" } }, type: "object" },
          name: "linear__list_issues",
        },
      ],
    });
  });

  it("does not activate tools for authorization and summary outputs", () => {
    expect(
      projectConnectionSearchActivation([
        { connection: "linear", description: "Linear", needsAuthorization: true },
        { connection: "github", description: "GitHub" },
      ]),
    ).toEqual({ tools: [] });
    expect(projectConnectionSearchActivation({ type: "authorization-pending" })).toEqual({
      tools: [],
    });
  });
});

describe("createConnectionSearchEvents", () => {
  it("marks the search tool as a loader and discovered tools as its targets", async () => {
    const runtimeContext = new ContextContainer();
    runtimeContext.set(ConnectionRegistryKey, {
      getConnectionApproval: () => undefined,
      getConnections: () => [
        {
          connectionName: "linear",
          description: "Linear",
          url: "https://linear.example.test/mcp",
        },
      ],
    } as never);
    const messages: Msg[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: [
              {
                connection: "linear",
                description: "List issues",
                inputSchema: { type: "object" },
                qualifiedName: "linear__list_issues",
                tool: "list_issues",
              },
            ],
          },
        ],
      },
    ];
    const handler = createConnectionSearchEvents()["step.started"]!;

    const tools = (await contextStorage.run(runtimeContext, () =>
      handler(
        {},
        {
          channel: {},
          messages,
          session: { auth: { current: null, initiator: null }, id: "session-1" },
        },
      ),
    )) as Record<string, object>;

    expect(getToolActivation(tools.connection_search)).toMatchObject({ kind: "loader" });
    expect(getToolActivation(tools.linear__list_issues)).toMatchObject({ kind: "target" });
    expect(getToolActivation(tools.connection_search)?.id).toBe(
      getToolActivation(tools.linear__list_issues)?.id,
    );
  });

  it("keeps a context-only definition eager after its activation result is compacted", async () => {
    const runtimeContext = new ContextContainer();
    let description = "Original description";
    runtimeContext.set(ConnectionRegistryKey, {
      getClient: () => ({
        getToolMetadata: async () => [
          {
            description,
            inputSchema: { type: "object" },
            name: "list_issues",
          },
        ],
      }),
      getConnectionApproval: () => undefined,
      getConnections: () => [
        {
          connectionName: "linear",
          description: "Linear",
          url: "https://linear.example.test/mcp",
        },
      ],
    } as never);
    const handler = createConnectionSearchEvents()["step.started"]!;

    await contextStorage.run(runtimeContext, async () => {
      const tools = (await handler(
        {},
        {
          channel: {},
          messages: [],
          session: { auth: { current: null, initiator: null }, id: "session-1" },
        },
      )) as Record<
        string,
        { execute(input: Record<string, unknown>, ctx: unknown): Promise<unknown> }
      >;
      const first = await tools.connection_search!.execute({ keywords: "issues" }, {});
      description = "Changed description";
      const second = await tools.connection_search!.execute({ keywords: "issues" }, {});

      expect(first).toMatchObject([{ description: "Original description" }]);
      expect(second).toMatchObject([{ description: "Original description" }]);

      const restored = (await handler(
        {},
        {
          channel: {},
          messages: [],
          session: { auth: { current: null, initiator: null }, id: "session-1" },
        },
      )) as Record<string, { description: string }>;
      expect(restored.linear__list_issues?.description).toBe("Original description");
      expect(getToolActivation(restored.linear__list_issues)).toBeUndefined();
    });
  });
});
