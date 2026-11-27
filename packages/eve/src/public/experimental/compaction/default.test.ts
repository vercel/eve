import { describe, expect, it, vi } from "vitest";

import { createFrameworkUserMessage } from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionCallRequest, CompactionContext } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

import {
  COMPACTION_PROMPT_ENVELOPE,
  COMPACTION_PROMPT_OVERHEAD_TOKENS,
} from "./checkpoint-prompt.js";
import { checkpointHead } from "./default-engine.js";
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

function context(kind: Kind, recompacting = false, tokens = 100_000) {
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
    model: { contextWindowTokens: 100_000, modelId: "gpt-5", provider: "openai.responses" },
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

describe("defaultCompaction()", () => {
  it("summarizes through ctx.call() and keeps the checkpoint head first", async () => {
    const { ctx, requests } = context("automatic");

    const kept = await compact(
      [user("First."), answer(filler), user("Second."), answer(filler), user("Now.")],
      ctx,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools).toBeUndefined();
    expect(kept.slice(0, 2)).toEqual(checkpointHead("SUMMARY"));
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
      expect(third).toEqual([...checkpointHead("SUMMARY"), user("Now.")]);
    });

    it("starts at the verbatim tail when the previous rewrite held", async () => {
      const withHead = [...(checkpointHead("EARLIER") as StoredHistoryMessage[]), ...recent];

      expect(hasTool(await compact(withHead, context("automatic").ctx))).toBe(true);
    });

    it("summarizes down to the latest message after an overflow", async () => {
      const withHead = [...(checkpointHead("EARLIER") as StoredHistoryMessage[]), ...recent];

      expect(hasTool(await compact(withHead, context("overflow").ctx))).toBe(false);
    });

    it("starts at the verbatim tail when the history has no checkpoint to escalate from", async () => {
      expect(hasTool(await compact(recent, context("automatic", true).ctx))).toBe(true);
    });

    it("goes to the summary alone when the previous tail held no tool turn", async () => {
      const kept = await compact(
        [
          ...(checkpointHead("EARLIER") as StoredHistoryMessage[]),
          user("Question."),
          answer("Reply."),
          user("Now."),
        ],
        context("automatic", true).ctx,
      );

      expect(kept).toEqual([...checkpointHead("SUMMARY"), user("Now.")]);
    });

    it("ignores it for a manual compaction", async () => {
      const withHead = [...(checkpointHead("EARLIER") as StoredHistoryMessage[]), ...recent];

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
});
