import { describe, expect, it } from "vitest";

import { extractDiscoveredTools } from "#runtime/framework-tools/connection-search-dynamic.js";

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

  it("returns empty for no tool results", () => {
    const messages: Msg[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    expect(extractDiscoveredTools(messages)).toHaveLength(0);
  });

  it("deduplicates by qualifiedName (latest wins)", () => {
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
    expect(result[0]!.description).toBe("New description");
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
