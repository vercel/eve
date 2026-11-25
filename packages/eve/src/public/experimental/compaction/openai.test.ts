import { describe, expect, it, vi } from "vitest";

import type { CompactionContext } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

import { openaiCompaction } from "./openai.js";

const item: StoredHistoryMessage = {
  content: [
    {
      kind: "openai.compaction",
      providerOptions: { openai: { encryptedContent: "ENC", itemId: "cmp_1" } },
      type: "custom",
    },
  ],
  role: "assistant",
};
const user = (text: string): StoredHistoryMessage => ({
  content: text,
  kind: "user",
  role: "user",
});
const reply: StoredHistoryMessage = {
  content: [{ text: "Noted.", type: "text" }],
  role: "assistant",
};
const injected: StoredHistoryMessage = {
  content: "STATE-NOTE",
  kind: "context.state",
  role: "user",
};
const toolResult: StoredHistoryMessage = {
  content: [
    {
      output: { type: "text", value: "Two cases." },
      toolCallId: "call_1",
      toolName: "lookup",
      type: "tool-result",
    },
  ],
  role: "tool",
};

type Flags = { overflow?: boolean; requested?: boolean; tokens?: number };

function context(provider = "openai.responses", modelId = "gpt-5", flags: Flags = {}) {
  const call = vi.fn(async () => ({ messages: [item], text: "" }));
  const ctx: CompactionContext = {
    abortSignal: new AbortController().signal,
    call,
    estimate: () => 0,
    estimateRatio: 1,
    fixedTokens: 0,
    model: { contextWindowTokens: 1_000, modelId, provider },
    overflow: flags.overflow ?? false,
    recompacting: false,
    requested: flags.requested ?? false,
    session: { id: "session" },
    tokens: flags.tokens ?? 950,
  };
  return { call, ctx };
}

const run = (history: StoredHistoryMessage[], ctx: CompactionContext) =>
  openaiCompaction()(history, ctx);

describe("openaiCompaction() budget", () => {
  const history = [user("One."), reply];

  it("compacts over 0.9 of the context window and declines at or under it", async () => {
    const over = context("openai.responses", "gpt-5", { tokens: 901 });
    const under = context("openai.responses", "gpt-5", { tokens: 900 });

    expect(await run(history, over.ctx)).toEqual([item]);
    expect(await run(history, under.ctx)).toBeUndefined();
    expect(under.call).not.toHaveBeenCalled();
  });

  it("uses its own threshold", async () => {
    const { call, ctx } = context("openai.responses", "gpt-5", { tokens: 700 });

    expect(await run(history, ctx)).toBeUndefined();
    expect(await openaiCompaction({ threshold: 0.6 })(history, ctx)).toEqual([item]);
    expect(call).toHaveBeenCalledOnce();
  });

  it.each([
    ["a manual compact", { requested: true }],
    ["a retry after a context-overflow error", { overflow: true }],
  ])("compacts under the threshold on %s", async (_, flags) => {
    const { call, ctx } = context("openai.responses", "gpt-5", { ...flags, tokens: 10 });

    expect(await run(history, ctx)).toEqual([item]);
    expect(call).toHaveBeenCalledOnce();
  });

  it("rejects a threshold outside 0 to 1", () => {
    expect(() => openaiCompaction({ threshold: 1.5 })).toThrow(/fraction of the context window/);
  });
});

describe("openaiCompaction() once per turn", () => {
  it.each([
    ["the item is the last message", [user("Review it."), item]],
    ["only messages eve injects follow the item", [user("Review it."), item, injected]],
  ])("declines when %s", async (_, history) => {
    const { call, ctx } = context();

    expect(await run(history, ctx)).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["a tool result follows the item", [user("Review it."), item, reply, toolResult]],
    ["the user spoke after the item", [user("One."), item, reply, user("Two.")]],
    ["the history holds no item", [user("One."), reply]],
  ])("compacts when %s", async (_, history) => {
    const { call, ctx } = context();

    expect(await run(history, ctx)).toEqual([item]);
    expect(call).toHaveBeenCalledWith({
      messages: history,
      providerOptions: { openai: { compactionTrigger: true } },
      tools: "inherit",
    });
  });

  it("leaves eve's injected messages out of the request", async () => {
    const { call, ctx } = context();

    await run([user("Review it."), injected, reply], ctx);

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [user("Review it."), reply] }),
    );
  });
});

describe("openaiCompaction() by model", () => {
  const fallback = vi.fn(async () => [reply]);
  const withFallback = (history: StoredHistoryMessage[], ctx: CompactionContext) =>
    openaiCompaction({ fallback })(history, ctx);

  it.each([
    ["the OpenAI Responses API", "openai.responses", "gpt-5"],
    ["an AI Gateway openai/ model", "gateway", "openai/gpt-5"],
  ])("compacts natively on %s", async (_, provider, modelId) => {
    const { call, ctx } = context(provider, modelId);

    expect(await withFallback([user("Review it."), reply], ctx)).toEqual([item]);
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          openai: { compactionTrigger: true },
          ...(provider === "gateway" && { gateway: { only: ["openai"] } }),
        },
      }),
    );
  });

  it.each([
    ["an AI Gateway model from another vendor", "gateway", "anthropic/claude-sonnet-4.5"],
    ["Anthropic", "anthropic.messages", "claude-sonnet-4-5"],
  ])("falls back on %s without calling the model", async (_, provider, modelId) => {
    const { call, ctx } = context(provider, modelId);
    fallback.mockClear();

    expect(await withFallback([user("Review it."), reply], ctx)).toEqual([reply]);
    expect(call).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back when the response holds no compaction record", async () => {
    const { call, ctx } = context("gateway", "openai/gpt-5");
    call.mockResolvedValueOnce({ messages: [reply], text: "Noted." });
    fallback.mockClear();

    expect(await withFallback([user("Review it."), reply], ctx)).toEqual([reply]);
    expect(fallback).toHaveBeenCalledOnce();
  });
});

describe("openaiCompaction() when the history already holds a record", () => {
  const fallback = vi.fn(async () => [reply]);
  const history = [user("One."), item, reply, user("Two."), reply];

  it("keeps the history and does not summarize it as text when the compaction call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { call, ctx } = context();
    call.mockRejectedValueOnce(new Error("compaction is unavailable"));
    fallback.mockClear();

    expect(await openaiCompaction({ fallback })(history, ctx)).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("keeps the history when the response holds no new record", async () => {
    const { call, ctx } = context();
    call.mockResolvedValueOnce({ messages: [reply], text: "Noted." });
    fallback.mockClear();

    expect(await openaiCompaction({ fallback })(history, ctx)).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });
});
