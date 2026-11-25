import { describe, expect, it, vi } from "vitest";

import { createFrameworkUserMessage } from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionCallRequest, CompactionContext } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

import {
  COMPACTION_PROMPT_ENVELOPE,
  COMPACTION_PROMPT_OVERHEAD_TOKENS,
} from "./checkpoint-prompt.js";
import { checkpoint } from "./default-engine.js";
import { defaultCompaction } from "./default.js";

const user = (text: string): StoredHistoryMessage => ({
  content: text,
  kind: "user",
  role: "user",
});
const answer = (text: string): StoredHistoryMessage => ({
  content: [{ text, type: "text" }],
  role: "assistant",
});
const toolTurn = (id: string): StoredHistoryMessage[] => [
  {
    content: [{ input: {}, toolCallId: id, toolName: "lookup", type: "tool-call" }],
    role: "assistant",
  },
  {
    content: [
      {
        output: { type: "text", value: `result ${id}` },
        toolCallId: id,
        toolName: "lookup",
        type: "tool-result",
      },
    ],
    role: "tool",
  },
];
const filler = "Alice reviewed the quarterly numbers. ".repeat(400);

type Kind = "automatic" | "manual" | "overflow";

const OPENAI = { modelId: "gpt-6.2-sol", provider: "openai.responses" };
const ANTHROPIC = { modelId: "claude-sonnet", provider: "anthropic.messages" };

function context(kind: Kind, recompacting = false, tokens = 100_000, model = ANTHROPIC) {
  const requests: CompactionCallRequest[] = [];
  const call = vi.fn(async (request: CompactionCallRequest) => {
    requests.push(request);
    return { messages: [answer("SUMMARY")], text: "SUMMARY" };
  });
  const ctx: CompactionContext = {
    abortSignal: new AbortController().signal,
    call,
    estimate: estimateTokens,
    estimateRatio: 1,
    fixedTokens: 0,
    model: { ...model, contextWindowTokens: 100_000 },
    overflow: kind === "overflow",
    recompacting,
    requested: kind === "manual",
    session: { id: "session" },
    tokens,
  };
  return { call, ctx, requests };
}

const compact = async (history: readonly StoredHistoryMessage[], ctx: CompactionContext) => [
  ...(await defaultCompaction()(history, ctx))!,
];

const reasoned = (id: string, text: string): StoredHistoryMessage => ({
  content: [
    {
      providerOptions: { openai: { itemId: `rs_${id}`, reasoningEncryptedContent: `enc-${id}` } },
      text: "",
      type: "reasoning",
    },
    { text, type: "text" },
  ],
  role: "assistant",
});
const bigToolTurn = (id: string): StoredHistoryMessage[] => {
  const [call, result] = toolTurn(id) as [StoredHistoryMessage, StoredHistoryMessage];
  const part = (result.content as { output: unknown }[])[0]!;
  part.output = { type: "text", value: "x".repeat(8_000) };
  return [call, result];
};

describe("defaultCompaction()", () => {
  it("summarizes through ctx.call() and keeps the checkpoint head first", async () => {
    const { ctx, requests } = context("automatic");

    const kept = await compact(
      [user("First."), answer(filler), user("Second."), answer(filler), user("Now.")],
      ctx,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools).toBeUndefined();
    expect(kept.slice(0, 2)).toEqual(checkpoint("SUMMARY"));
    expect(kept.at(-1)).toEqual(user("Now."));
  });

  it("adds the author's instructions to eve's checkpoint prompt", async () => {
    const { ctx, requests } = context("automatic");
    const strategy = defaultCompaction({ instructions: "Keep every ticket ID." });

    await strategy([user("First."), answer(filler), user("Now.")], ctx);

    expect(requests[0]!.system).toContain("Keep every ticket ID.");
  });

  describe("when a rewrite did not hold for one response", () => {
    const recent = [user("Read it."), ...toolTurn("a"), answer("Done."), user("Now.")];
    const earlier = [user("Old notes."), answer(filler), ...recent];
    const hasTool = (history: readonly StoredHistoryMessage[]) =>
      history.some((message) => message.role === "tool");

    it("escalates from the verbatim tail to the text tail to the summary alone", async () => {
      const first = await compact(earlier, context("automatic").ctx);
      const second = await compact(first, context("automatic", true).ctx);
      const third = await compact(second, context("automatic", true).ctx);

      expect(hasTool(first)).toBe(true);
      expect(hasTool(second)).toBe(false);
      expect(second.length).toBeGreaterThan(3);
      expect(third).toEqual([...checkpoint("SUMMARY"), user("Now.")]);
    });

    it("starts at the verbatim tail when the previous rewrite held", async () => {
      const withHead = [...(checkpoint("EARLIER") as StoredHistoryMessage[]), ...recent];

      expect(hasTool(await compact(withHead, context("automatic").ctx))).toBe(true);
      expect(hasTool(await compact(withHead, context("overflow").ctx))).toBe(true);
    });

    it("starts at the verbatim tail when the history has no checkpoint to escalate from", async () => {
      expect(hasTool(await compact(recent, context("automatic", true).ctx))).toBe(true);
    });

    it("goes to the summary alone when the previous tail held no tool turn", async () => {
      const kept = await compact(
        [
          ...(checkpoint("EARLIER") as StoredHistoryMessage[]),
          user("Question."),
          answer("Reply."),
          user("Now."),
        ],
        context("automatic", true).ctx,
      );

      expect(kept).toEqual([...checkpoint("SUMMARY"), user("Now.")]);
    });

    it("ignores it for a manual compaction", async () => {
      const withHead = [...(checkpoint("EARLIER") as StoredHistoryMessage[]), ...recent];

      expect(await compact(withHead, context("manual", true).ctx)).toEqual(
        await compact(withHead, context("manual", false).ctx),
      );
    });
  });

  it("keeps the history without a model call while the request is within 0.9 of the window", async () => {
    const { call, ctx } = context("automatic", false, 90_000 - COMPACTION_PROMPT_OVERHEAD_TOKENS);

    expect(await defaultCompaction()([user("Now.")], ctx)).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it("compacts one token past the threshold, which counts the summary prompt's overhead", async () => {
    const { ctx, requests } = context(
      "automatic",
      false,
      90_000 - COMPACTION_PROMPT_OVERHEAD_TOKENS + 1,
    );

    expect(
      await defaultCompaction()([user("First."), answer(filler), user("Now.")], ctx),
    ).toBeDefined();
    expect(requests).toHaveLength(1);
  });

  it("compacts at the author's threshold", async () => {
    const tokens = 70_000 - COMPACTION_PROMPT_OVERHEAD_TOKENS;
    const strategy = defaultCompaction({ threshold: 0.7 });
    const history = [user("First."), answer(filler), user("Now.")];

    expect(await strategy(history, context("automatic", false, tokens).ctx)).toBeUndefined();
    expect(await strategy(history, context("automatic", false, tokens + 1).ctx)).toBeDefined();
  });

  it.each(["manual", "overflow"] as const)(
    "compacts a %s request whatever the size",
    async (kind) => {
      const { requests, ctx } = context(kind, false, 10);

      expect(
        await defaultCompaction()([user("First."), answer(filler), user("Now.")], ctx),
      ).toBeDefined();
      expect(requests).toHaveLength(1);
    },
  );

  it("budgets the summary request's fixed prompt when it clears tool results", () => {
    expect(COMPACTION_PROMPT_OVERHEAD_TOKENS).toBe(
      estimateTokens([
        { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
        createFrameworkUserMessage("context.compaction", COMPACTION_PROMPT_ENVELOPE.prompt),
      ]),
    );
  });

  describe("on a model that reads OpenAI's items", () => {
    const openai = (kind: Kind = "automatic", recompacting = false) =>
      context(kind, recompacting, 100_000, OPENAI);
    const earlier = [user("Old notes."), answer(filler), user("Old question."), answer(filler)];
    const turn = [user("Read it."), reasoned("1", "Reading."), ...bigToolTurn("a")];
    const recent = [...turn, reasoned("2", "Done."), user("Now.")];

    it("appends the checkpoint and keeps every kept message exactly as it was", async () => {
      const history = [...earlier, ...recent];
      const kept = await compact(history, openai().ctx);

      const body = kept.slice(0, -3);
      expect(body.length).toBeGreaterThanOrEqual(recent.length);
      body.forEach((message, index) => expect(message).toBe(history.at(index - body.length)));
      expect(kept.slice(-3, -1)).toEqual(checkpoint("SUMMARY"));
    });

    it("hands the summarizer the capped transcript, not the kept messages", async () => {
      const { ctx, requests } = openai();

      await compact([...earlier, ...recent], ctx);

      const prompt = JSON.stringify(requests[0]!.messages);
      expect(prompt).toContain("Truncated by eve");
      expect(prompt).not.toContain("x".repeat(8_000));
    });

    it("puts the replayed ask after the checkpoint when compaction dropped it", async () => {
      const ask = user("Now.");
      const kept = await compact(
        [...earlier, ask, ...bigToolTurn("a"), reasoned("2", "Done."), ...bigToolTurn("b")],
        { ...openai().ctx, estimate: (messages) => estimateTokens(messages) * 20 },
      );

      expect(kept.at(-1)).toEqual(ask);
      expect(kept.at(-2)).toEqual(checkpoint("SUMMARY")[1]);
    });

    it("ends on a continuation message when the ask is among the kept messages", async () => {
      const kept = await compact([...earlier, ...recent], openai().ctx);

      expect(kept.at(-1)).toMatchObject({ content: "Continue.", kind: "execution.continuation" });
      expect(kept.at(-2)).toEqual(checkpoint("SUMMARY")[1]);
    });

    it("skips the text tail when a rewrite did not hold for one response", async () => {
      const first = await compact([...earlier, ...recent], openai().ctx);
      const second = await compact(first, openai("automatic", true).ctx);

      expect(second.some((message) => message.role === "tool")).toBe(false);
      expect(second.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    });

    it("finds a checkpoint in the middle of the history and leaves one", async () => {
      const first = await compact([...earlier, ...recent], openai().ctx);
      const later = [...first, user("Next."), answer(filler), user("Last.")];
      const { ctx, requests } = openai();
      ctx.call = vi.fn(async (request: CompactionCallRequest) => {
        requests.push(request);
        return { messages: [answer("SECOND")], text: "SECOND" };
      });

      const kept = await compact(later, ctx);

      expect(JSON.stringify(requests[0]!.messages)).toContain("SUMMARY");
      expect(
        kept.filter((message) => (message as { kind?: string }).kind === "context.compaction"),
      ).toHaveLength(1);
      expect(kept).toContainEqual(checkpoint("SECOND")[1]);
      expect(kept).not.toContainEqual(checkpoint("SUMMARY")[1]);
    });

    it("rewrites the same history on another model the way it did before", async () => {
      const history = [...earlier, ...recent];
      const kept = await compact(history, context("automatic").ctx);

      expect(kept.slice(0, 2)).toEqual(checkpoint("SUMMARY"));
      expect(JSON.stringify(kept)).toContain("Truncated by eve");
    });
  });
});
