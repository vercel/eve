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
const ofKind = (
  kind: "task.result" | "execution.continuation",
  text: string,
): StoredHistoryMessage => ({
  content: text,
  kind,
  role: "user",
});
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
  const compacted = [item, user("One.")];

  it("compacts over 0.9 of the context window and declines at or under it", async () => {
    const over = context("openai.responses", "gpt-5", { tokens: 901 });
    const under = context("openai.responses", "gpt-5", { tokens: 900 });

    expect(await run(history, over.ctx)).toEqual(compacted);
    expect(await run(history, under.ctx)).toBeUndefined();
    expect(under.call).not.toHaveBeenCalled();
  });

  it("uses its own threshold", async () => {
    const { call, ctx } = context("openai.responses", "gpt-5", { tokens: 700 });

    expect(await run(history, ctx)).toBeUndefined();
    expect(await openaiCompaction({ threshold: 0.6 })(history, ctx)).toEqual(compacted);
    expect(call).toHaveBeenCalledOnce();
  });

  it.each([
    ["a manual compact", { requested: true }],
    ["a retry after a context-overflow error", { overflow: true }],
  ])("compacts under the threshold on %s", async (_, flags) => {
    const { call, ctx } = context("openai.responses", "gpt-5", { ...flags, tokens: 10 });

    expect(await run(history, ctx)).toEqual(compacted);
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
    [
      "only the resent user message follows the item",
      [user("Review it."), item, user("Review it.")],
    ],
  ])("declines when %s", async (_, history) => {
    const { call, ctx } = context();

    expect(await run(history, ctx)).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["a tool result follows the item", [user("Review it."), item, reply, toolResult], "Review it."],
    ["the user spoke after the item", [user("One."), item, reply, user("Two.")], "Two."],
    ["the history holds no item", [user("One."), reply], "One."],
  ])(
    "compacts when %s and keeps the latest user message after the record",
    async (_, history, latest) => {
      const { call, ctx } = context();

      expect(await run(history, ctx)).toEqual([item, user(latest)]);
      expect(call).toHaveBeenCalledWith({
        messages: history,
        providerOptions: { openai: { compactionTrigger: true } },
        tools: "inherit",
      });
    },
  );

  it.each([
    ["a task result", ofKind("task.result", "TASK-RESULT")],
    ["a continuation", ofKind("execution.continuation", "CONTINUE")],
  ])("keeps the user's own message over %s that comes after it", async (_, later) => {
    const { ctx } = context();
    const history = [user("Review it."), reply, later];

    expect(await run(history, ctx)).toEqual([item, user("Review it.")]);
  });

  it("keeps a later non-injected user message when the history holds no plain user message", async () => {
    const { ctx } = context();
    const taskResult = ofKind("task.result", "TASK-RESULT");

    expect(await run([reply, taskResult], ctx)).toEqual([item, taskResult]);
  });

  it("sends eve's injected messages with the request and does not resend them after the record", async () => {
    const { call, ctx } = context();
    const history = [user("Review it."), injected, reply, injected];

    expect(await run(history, ctx)).toEqual([item, user("Review it.")]);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ messages: history }));
  });

  it("returns the record alone when no user message is in the history", async () => {
    const { ctx } = context();

    expect(await run([injected, reply], ctx)).toEqual([item]);
  });
});

describe("openaiCompaction() by model", () => {
  it.each([
    ["the OpenAI Responses API", "openai.responses", "gpt-5"],
    ["an AI Gateway openai/ model", "gateway", "openai/gpt-5"],
  ])("compacts natively on %s", async (_, provider, modelId) => {
    const { call, ctx } = context(provider, modelId);

    expect(await run([user("Review it."), reply], ctx)).toEqual([item, user("Review it.")]);
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
});

describe("openaiCompaction() when OpenAI does not compact", () => {
  const history = [user("One."), item, reply, user("Two."), reply];

  it.each([
    ["has no record yet", [user("Review it."), reply]],
    ["already holds a record", history],
  ])("rejects when the compaction call fails and the history %s", async (_, messages) => {
    const { call, ctx } = context();
    call.mockRejectedValueOnce(new Error("compaction is unavailable"));

    await expect(run(messages, ctx)).rejects.toThrow("compaction is unavailable");
  });

  it.each([
    ["has no record yet", [user("Review it."), reply]],
    ["already holds a record", history],
  ])(
    "rejects when the response holds no compaction record and the history %s",
    async (_, messages) => {
      const { call, ctx } = context("gateway", "openai/gpt-5");
      call.mockResolvedValueOnce({ messages: [reply], text: "Noted." });

      await expect(run(messages, ctx)).rejects.toThrow(
        "gateway openai/gpt-5 answered the compaction request without a compaction record.",
      );
    },
  );
});
