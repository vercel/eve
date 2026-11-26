import { describe, expect, it, vi } from "vitest";

import { estimateTokens } from "#harness/token-estimate.js";
import { CompactionOverLimitError } from "#shared/compaction-over-limit-error.js";
import type { CompactionContext } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

import {
  assertThreshold,
  belowThreshold,
  budgetAgainstWindow,
  budgetAt,
  historyBudget,
  thresholdTokens,
} from "./budget.js";
import { COMPACTION_PROMPT_OVERHEAD_TOKENS } from "./checkpoint-prompt.js";
import { defaultCompaction } from "./default.js";

describe("thresholdTokens", () => {
  it("is a share of the model's context window", () => {
    expect(thresholdTokens(1_000_000, 0.9)).toBe(900_000);
    expect(thresholdTokens(200_000, 0.5)).toBe(100_000);
    expect(thresholdTokens(1_001, 0.5)).toBe(500);
  });

  it("is 100k tokens for a model whose window it doesn't know", () => {
    expect(thresholdTokens(undefined, 0.9)).toBe(100_000);
  });

  it("is at least one token", () => {
    expect(thresholdTokens(1_000, 0)).toBe(1);
  });
});

describe("budgetAt", () => {
  it("compacts past a share of the window and down to half of it", () => {
    expect(budgetAt(1_000_000, 0.9)).toEqual({ target: 500_000, threshold: 900_000 });
  });

  it("never aims above the threshold", () => {
    expect(budgetAt(200_000, 0.4)).toEqual({ target: 80_000, threshold: 80_000 });
  });

  it("aims for 50k tokens when the window is unknown", () => {
    expect(budgetAt(undefined, 0.9)).toEqual({ target: 50_000, threshold: 100_000 });
  });
});

describe("budgetAgainstWindow", () => {
  it("compacts past the whole window and down to half of it", () => {
    expect(budgetAgainstWindow(200_000)).toEqual({ target: 100_000, threshold: 200_000 });
  });
});

describe("assertThreshold", () => {
  it.each([0, 0.5, 1])("accepts %s", (fraction) => {
    expect(() => assertThreshold(fraction)).not.toThrow();
  });

  it.each([-0.2, 1.5, Number.NaN])("rejects %s", (fraction) => {
    expect(() => assertThreshold(fraction)).toThrow("a fraction of the context window from 0 to 1");
  });
});

describe("belowThreshold", () => {
  const at = (tokens: number, flags: { overflow?: boolean; requested?: boolean } = {}) => ({
    overflow: false,
    requested: false,
    tokens,
    ...flags,
  });

  it("holds until the tokens, with the overhead, pass the threshold", () => {
    expect(belowThreshold(at(900), 1_000, 100)).toBe(true);
    expect(belowThreshold(at(901), 1_000, 100)).toBe(false);
  });

  it("never holds for a requested compaction or an overflow retry", () => {
    expect(belowThreshold(at(1, { requested: true }), 1_000)).toBe(false);
    expect(belowThreshold(at(1, { overflow: true }), 1_000)).toBe(false);
  });
});

describe("historyBudget", () => {
  it("takes the fixed part out of the threshold and the target", () => {
    expect(
      historyBudget({ target: 5_000, threshold: 10_000 }, { estimateRatio: 1, fixedTokens: 1_000 }),
    ).toEqual({ target: 4_000, threshold: 9_000 });
  });

  it("converts the target into estimate units", () => {
    expect(
      historyBudget({ target: 5_000, threshold: 10_000 }, { estimateRatio: 2, fixedTokens: 1_000 }),
    ).toEqual({ target: 1_500, threshold: 9_000 });
  });

  it("throws when the fixed part alone reaches the threshold", () => {
    expect(() =>
      historyBudget(
        { target: 5_000, threshold: 10_000 },
        { estimateRatio: 1, fixedTokens: 10_000 },
      ),
    ).toThrow(CompactionOverLimitError);
  });
});

const user = (text: string): StoredHistoryMessage => ({
  content: text,
  kind: "user",
  role: "user",
});
const answer = (text: string): StoredHistoryMessage => ({
  content: [{ text, type: "text" }],
  role: "assistant",
});
const history = [
  user("First."),
  answer("Alice reviewed the quarterly numbers. ".repeat(400)),
  user("Now."),
];

function context(overrides: Partial<CompactionContext> & { window?: number | null } = {}) {
  const { window = 10_000, ...rest } = overrides;
  const call = vi.fn(async () => ({ messages: [answer("SUMMARY")], text: "SUMMARY" }));
  const ctx: CompactionContext = {
    abortSignal: new AbortController().signal,
    call,
    estimate: estimateTokens,
    estimateRatio: 1,
    fixedTokens: 0,
    model: {
      modelId: "gpt-5",
      provider: "openai.responses",
      ...(window !== null && { contextWindowTokens: window }),
    },
    overflow: false,
    recompacting: false,
    requested: false,
    session: { id: "session" },
    tokens: 9_500,
    ...rest,
  };
  return { call, ctx };
}

describe("defaultCompaction() budget", () => {
  it("makes no model call while the request is within the threshold", async () => {
    const { call, ctx } = context({ tokens: 9_000 - COMPACTION_PROMPT_OVERHEAD_TOKENS });

    expect(await defaultCompaction()(history, ctx)).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it("compacts past the threshold", async () => {
    const { call, ctx } = context();

    expect(await defaultCompaction()(history, ctx)).toBeDefined();
    expect(call).toHaveBeenCalledOnce();
  });

  it("compacts against the whole window when the fixed part exceeds the threshold but not the window", async () => {
    const { call, ctx } = context({ fixedTokens: 9_500, tokens: 9_900 });

    expect(await defaultCompaction()(history, ctx)).toBeDefined();
    expect(call).toHaveBeenCalledOnce();
  });

  it("throws when the fixed part leaves no room in the window either", async () => {
    const { call, ctx } = context({ fixedTokens: 10_000, tokens: 10_500 });

    await expect(defaultCompaction()(history, ctx)).rejects.toThrow(
      /leave no room for the conversation in this model's ~10000-token context window/,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("sends the request as it is when the window is unknown and the fixed part exceeds 100k", async () => {
    const { call, ctx } = context({ fixedTokens: 100_000, tokens: 101_000, window: null });

    expect(await defaultCompaction()(history, ctx)).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it("throws for a requested compaction instead of falling back to the window", async () => {
    const { call, ctx } = context({ fixedTokens: 9_500, requested: true });

    await expect(defaultCompaction()(history, ctx)).rejects.toThrow(CompactionOverLimitError);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([-0.1, 1.5, Number.NaN])("rejects threshold %s when it is created", (threshold) => {
    expect(() => defaultCompaction({ threshold })).toThrow(
      "a fraction of the context window from 0 to 1",
    );
  });
});
