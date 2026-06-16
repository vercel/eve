import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compactMessages,
  estimateTokens,
  getInputTokenCount,
  resolveCompactionModel,
  shouldCompact,
} from "#harness/compaction.js";
import type { CompactionConfig } from "#harness/types.js";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const config: CompactionConfig = {
  recentWindowSize: 2,
  threshold: 100,
};

describe("estimateTokens", () => {
  it("estimates based on serialized character length", () => {
    const messages: ModelMessage[] = [{ content: "a".repeat(400), role: "user" }];
    // JSON.stringify wraps the payload with struct chars; the estimate is
    // serialized-length / 4. The exact value matters less than the rough
    // relationship to raw content length.
    expect(estimateTokens(messages)).toBeGreaterThanOrEqual(100);
    expect(estimateTokens(messages)).toBeLessThan(120);
  });

  it("treats structured payloads as denser than plain text of similar size", () => {
    const text = "a".repeat(400);
    const plain: ModelMessage[] = [{ content: text, role: "user" }];
    const structured: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "json", value: { value: text } },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    expect(estimateTokens(structured)).toBeGreaterThan(estimateTokens(plain));
  });

  it("counts structured tool-result payloads when they grow", () => {
    const small: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "json", value: { value: "a" } },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    const large: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "json", value: { value: "a".repeat(400) } },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    expect(estimateTokens(large)).toBeGreaterThan(estimateTokens(small));
  });

  it("counts all content parts including reasoning", () => {
    // The simplified estimator uses JSON.stringify(messages).length / 4 with
    // no type-specific skipping. Reasoning contributes to the estimate like
    // any other payload — this is intentional: the true token count comes
    // back from the model each step via `lastKnownInputTokens`, so the
    // heuristic only needs to roughly track size.
    const base: ModelMessage[] = [
      {
        content: [
          {
            input: { query: "debug logs" },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
    ];
    const withReasoning: ModelMessage[] = [
      ...base,
      {
        content: [
          {
            text: "chain of thought",
            type: "reasoning",
          },
        ],
        role: "assistant",
      },
    ];

    expect(estimateTokens(base)).toBeGreaterThan(0);
    expect(estimateTokens(withReasoning)).toBeGreaterThan(estimateTokens(base));
  });
});

describe("getInputTokenCount", () => {
  it("prefers the last known exact token count when available", () => {
    const messages: ModelMessage[] = [{ content: "a".repeat(400), role: "user" }];

    const result = getInputTokenCount(messages, {
      ...config,
      lastKnownInputTokens: 42,
      lastKnownPromptMessageCount: 1,
    });
    // No appended messages — tail is empty. The rough estimate adds a tiny
    // constant for the "[]" serialization; the exact prior count dominates.
    expect(result).toBeGreaterThanOrEqual(42);
    expect(result).toBeLessThan(43);
  });

  it("adds appended-message estimates on top of the last exact prompt count", () => {
    const messages: ModelMessage[] = [
      { content: "a".repeat(400), role: "user" },
      { content: "b".repeat(80), role: "assistant" },
    ];

    const result = getInputTokenCount(messages, {
      ...config,
      lastKnownInputTokens: 42,
      lastKnownPromptMessageCount: 1,
    });
    // prior (42) + rough estimate of the one appended assistant message.
    // The assistant message is ~80 content chars plus JSON struct overhead.
    expect(result).toBeGreaterThan(42 + 20);
    expect(result).toBeLessThan(42 + 40);
  });
});

describe("shouldCompact", () => {
  it("returns false when under threshold", () => {
    const messages: ModelMessage[] = [{ content: "short", role: "user" }];
    expect(shouldCompact(messages, config)).toBe(false);
  });

  it("returns true when over threshold", () => {
    const messages: ModelMessage[] = [{ content: "a".repeat(500), role: "user" }];
    expect(shouldCompact(messages, config)).toBe(true);
  });
});

describe("resolveCompactionModel", () => {
  it("reuses the active model when compaction uses the same reference", async () => {
    const model = {} as Parameters<typeof resolveCompactionModel>[0]["model"];
    const resolveModel = vi.fn();

    const result = await resolveCompactionModel({
      model,
      modelReference: { id: "main", providerOptions: { openai: { reasoning: { effort: "low" } } } },
      resolveModel,
    });

    expect(result.model).toBe(model);
    expect(result.providerOptions).toEqual({
      openai: { reasoning: { effort: "low" } },
    });
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("resolves the authored compaction model when configured", async () => {
    const model = {} as Parameters<typeof resolveCompactionModel>[0]["model"];
    const summaryModel = {} as Parameters<typeof resolveCompactionModel>[0]["model"];
    const resolveModel = vi.fn().mockResolvedValue(summaryModel);

    const compactionModelReference = {
      id: "summary",
      providerOptions: {
        anthropic: {
          thinking: {
            budget_tokens: 128,
          },
        },
      },
    } as Parameters<typeof resolveCompactionModel>[0]["compactionModelReference"];

    const result = await resolveCompactionModel({
      compactionModelReference,
      model,
      modelReference: { id: "main" },
      resolveModel,
    });

    expect(result.model).toBe(summaryModel);
    expect(result.providerOptions).toEqual({
      anthropic: {
        thinking: {
          budget_tokens: 128,
        },
      },
    });
    expect(resolveModel).toHaveBeenCalledWith(compactionModelReference);
  });
});

describe("compactMessages", () => {
  it("summarizes older messages and keeps recent window", async () => {
    const { generateText } = await import("ai");

    vi.mocked(generateText).mockResolvedValue({
      text: "Summary of prior context",
    } as Awaited<ReturnType<typeof generateText>>);

    const messages: ModelMessage[] = [
      { content: "old message 1", role: "user" },
      { content: "old message 2", role: "assistant" },
      { content: "recent 1", role: "user" },
      { content: "recent 2", role: "assistant" },
    ];

    const model = {} as Parameters<typeof compactMessages>[1];
    const result = await compactMessages(messages, model, config);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({
      content: "Summary of our conversation so far:",
      role: "user",
    });
    expect(result[1]).toEqual({
      content: "Summary of prior context",
      role: "assistant",
    });
    expect(result[2]).toEqual({ content: "recent 1", role: "user" });
    expect(result[3]).toEqual({ content: "recent 2", role: "assistant" });
    expect(result[4]).toEqual({ content: "Continue.", role: "user" });
  });

  it("forwards provider options to the compaction model call", async () => {
    const { generateText } = await import("ai");

    vi.mocked(generateText).mockResolvedValue({
      text: "Summary of prior context",
    } as Awaited<ReturnType<typeof generateText>>);

    const messages: ModelMessage[] = [
      { content: "old message 1", role: "user" },
      { content: "old message 2", role: "assistant" },
      { content: "recent 1", role: "user" },
      { content: "recent 2", role: "assistant" },
    ];

    const model = {} as Parameters<typeof compactMessages>[1];
    const providerOptions = {
      anthropic: {
        thinking: {
          budget_tokens: 128,
        },
      },
    };

    await compactMessages(messages, model, config, providerOptions);

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        providerOptions,
      }),
    );
  });

  it("folds oversized recent tool results into the summary when the raw tail does not fit", async () => {
    const { generateText } = await import("ai");

    vi.mocked(generateText).mockResolvedValue({
      text: "Summary of the large SQL result",
    } as Awaited<ReturnType<typeof generateText>>);

    const messages: ModelMessage[] = [
      { content: "Find the relevant rows.", role: "user" },
      {
        content: [
          {
            input: { sql: "select * from events" },
            toolCallId: "call-1",
            toolName: "execute_sql",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: {
                rows: Array.from({ length: 50 }, (_, index) => ({
                  id: index,
                  payload: "x".repeat(200),
                })),
              },
            },
            toolCallId: "call-1",
            toolName: "execute_sql",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const model = {} as Parameters<typeof compactMessages>[1];
    const result = await compactMessages(messages, model, {
      recentWindowSize: 10,
      threshold: 150,
    });

    expect(result).toEqual([
      {
        content: "Summary of our conversation so far:",
        role: "user",
      },
      {
        content: "Summary of the large SQL result",
        role: "assistant",
      },
    ]);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });

  it("forwards headers to the generateText call", async () => {
    const { generateText } = await import("ai");

    vi.mocked(generateText).mockResolvedValue({
      text: "Summary of prior context",
    } as Awaited<ReturnType<typeof generateText>>);

    const messages: ModelMessage[] = [
      { content: "old message 1", role: "user" },
      { content: "old message 2", role: "assistant" },
      { content: "recent 1", role: "user" },
      { content: "recent 2", role: "assistant" },
    ];

    const model = {} as Parameters<typeof compactMessages>[1];
    const headers = {
      "x-title": "My Agent",
      "http-referer": "https://my-agent.vercel.app",
    };

    await compactMessages(messages, model, config, undefined, undefined, headers);

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        headers,
        model,
      }),
    );
  });

  it("summarizes structured tool messages without dumping raw JSON", async () => {
    const { generateText } = await import("ai");

    vi.mocked(generateText).mockResolvedValue({
      text: "Summary of prior context",
    } as Awaited<ReturnType<typeof generateText>>);

    const messages: ModelMessage[] = [
      { content: "old message 1", role: "user" },
      {
        content: [
          {
            input: { query: "debug" },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: ["alpha", "beta", "gamma", "delta"],
            },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      { content: "recent 1", role: "user" },
      { content: "recent 2", role: "assistant" },
    ];

    const model = {} as Parameters<typeof compactMessages>[1];
    await compactMessages(messages, model, config);

    const call = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(call?.system).toContain("conversation summarizer");
    expect(call?.prompt).toContain("Conversation transcript:");
    expect(call?.prompt).toContain("### assistant");
    expect(call?.prompt).toContain("Called search with object(query=debug)");
    expect(call?.prompt).toContain(
      "Tool search returned object(type=json, value=array(4: alpha, beta, gamma, …))",
    );
    expect(call?.prompt).not.toContain('{"query"');
    expect(call?.prompt).not.toContain('{"items"');
  });

  it("appends synthetic user message when recent window trails with assistant", async () => {
    const { generateText } = await import("ai");

    vi.mocked(generateText).mockResolvedValue({
      text: "Summary of prior context",
    } as Awaited<ReturnType<typeof generateText>>);

    const messages: ModelMessage[] = [
      { content: "old message", role: "user" },
      { content: "old reply", role: "assistant" },
      { content: "assistant trailing", role: "assistant" },
    ];

    const model = {} as Parameters<typeof compactMessages>[1];
    const result = await compactMessages(messages, model, {
      recentWindowSize: 1,
      threshold: 100,
    });

    expect(result.at(-1)).toEqual({ content: "Continue.", role: "user" });
  });

  it("does not append synthetic user message when recent window ends with user or tool", async () => {
    const { generateText } = await import("ai");

    vi.mocked(generateText).mockResolvedValue({
      text: "Summary",
    } as Awaited<ReturnType<typeof generateText>>);

    const messages: ModelMessage[] = [
      { content: "old", role: "user" },
      { content: "old reply", role: "assistant" },
      { content: "latest question", role: "user" },
    ];

    const model = {} as Parameters<typeof compactMessages>[1];
    const result = await compactMessages(messages, model, {
      recentWindowSize: 1,
      threshold: 100,
    });

    expect(result.at(-1)).toEqual({ content: "latest question", role: "user" });
  });
});
