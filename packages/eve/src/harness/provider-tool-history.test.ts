import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { normalizeProviderToolHistory } from "#harness/provider-tool-history.js";

describe("normalizeProviderToolHistory", () => {
  it("preserves text ordering around provider-executed tool results", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will look that up." },
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { objective: "Current result" },
          },
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
          { type: "text", text: "The search returned no results." },
        ],
      },
    ];

    const normalized = normalizeProviderToolHistory({
      messages,
      providerExecutedOutcomeIds: new Set(["search-1"]),
    });

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will look that up." },
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { objective: "Current result" },
            providerExecuted: false,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The search returned no results." }],
      },
    ]);
    expect(normalized.outcomeEndsResponse).toBe(false);
  });

  it("groups consecutive provider results without changing their order", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { objective: "First" },
          },
          {
            type: "tool-call",
            toolCallId: "search-2",
            toolName: "web_search",
            input: { objective: "Second" },
          },
          {
            type: "tool-result",
            toolCallId: "search-2",
            toolName: "web_search",
            output: { type: "json", value: { results: [2] } },
          },
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [1] } },
          },
        ],
      },
    ];

    const normalized = normalizeProviderToolHistory({
      messages,
      providerExecutedOutcomeIds: new Set(["search-1", "search-2"]),
    });

    expect(normalized.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(normalized.messages[1]?.content).toEqual([
      expect.objectContaining({ toolCallId: "search-2" }),
      expect.objectContaining({ toolCallId: "search-1" }),
    ]);
    expect(normalized.outcomeEndsResponse).toBe(true);
  });

  it("preserves native provider-owned tool history", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { query: "Current result" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
        ],
      },
    ];

    const normalized = normalizeProviderToolHistory({
      messages,
      providerExecutedOutcomeIds: new Set(["search-1"]),
    });

    expect(normalized.messages).toEqual(messages);
    expect(normalized.outcomeEndsResponse).toBe(true);
  });

  it("starts a new assistant message after native provider results so replay keeps the answer after them", () => {
    const call = (toolCallId: string) =>
      ({
        type: "tool-call",
        toolCallId,
        toolName: "web_search",
        input: { query: toolCallId },
        providerExecuted: true,
      }) as const;
    const result = (toolCallId: string) =>
      ({
        type: "tool-result",
        toolCallId,
        toolName: "web_search",
        output: { type: "json", value: { results: [toolCallId] } },
      }) as const;
    const reasoning = {
      type: "reasoning",
      text: "Search both.",
      providerOptions: { anthropic: { signature: "sig" } },
    } as const;
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          reasoning,
          { type: "text", text: "I'll look both up." },
          call("search-1"),
          call("search-2"),
          result("search-1"),
          result("search-2"),
          { type: "text", text: "The Knicks and the Hurricanes won." },
        ],
      },
    ];

    const normalized = normalizeProviderToolHistory({
      messages,
      providerExecutedOutcomeIds: new Set(["search-1", "search-2"]),
    });

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: [
          reasoning,
          { type: "text", text: "I'll look both up." },
          call("search-1"),
          call("search-2"),
          result("search-1"),
          result("search-2"),
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The Knicks and the Hurricanes won." }],
      },
    ]);
    expect(normalized.outcomeEndsResponse).toBe(false);
  });

  it("keeps local tool calls next to their results around provider-owned results", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { query: "Current result" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
          {
            type: "tool-call",
            toolCallId: "read-1",
            toolName: "read_file",
            input: { filePath: "/workspace/a.ts" },
          },
          {
            type: "tool-call",
            toolCallId: "search-2",
            toolName: "web_search",
            input: { query: "Follow-up result" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "search-2",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            toolName: "read_file",
            output: { type: "json", value: { content: "" } },
          },
        ],
      },
    ];

    const normalized = normalizeProviderToolHistory({
      messages,
      providerExecutedOutcomeIds: new Set(["search-1", "search-2"]),
    });

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { query: "Current result" },
            providerExecuted: false,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "search-2",
            toolName: "web_search",
            input: { query: "Follow-up result" },
            providerExecuted: false,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "search-2",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-1",
            toolName: "read_file",
            input: { filePath: "/workspace/a.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            toolName: "read_file",
            output: { type: "json", value: { content: "" } },
          },
        ],
      },
    ]);
  });
});
