import type { StoredHistoryMessage } from "eve/compaction";
import { describe, expect, it } from "vitest";

import { SUMMARIZATION_PROMPT, SUMMARY_PREFIX, codexCompaction } from "./codex.js";
import { compactOf, dueOf, fakeContext, ids, pairsIntact, toolTurn, user } from "./fake.js";

const history: StoredHistoryMessage[] = [
  user("first ask"),
  ...toolTurn("call-1", "output one"),
  { role: "assistant", content: "done one" },
  { role: "user", kind: "execution.continuation", content: "continue" },
  user("second ask " + "y".repeat(400)),
  ...toolTurn("call-2", "output two"),
  { role: "assistant", content: "done two" },
  user("third ask"),
];

describe("codexCompaction", () => {
  it("keeps the person messages and puts the summary after them", async () => {
    const { ctx, calls } = fakeContext({ limit: 100_000 });
    const result = await compactOf(codexCompaction())(history, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual(history);
    expect(calls[0]!.options).toEqual({ prompt: SUMMARIZATION_PROMPT, model: undefined });
    expect(result).toEqual([
      user("first ask"),
      history[5],
      user("third ask"),
      { role: "user", kind: "context.compaction", content: `${SUMMARY_PREFIX}\nSUMMARY` },
    ]);
  });

  it("leaves an earlier summary out of the person messages it keeps", async () => {
    const { ctx } = fakeContext({ limit: 100_000 });
    const first = await compactOf(codexCompaction())(history, ctx);
    const second = await compactOf(codexCompaction())([...first!, user("fourth ask")], ctx);
    expect(
      second!.filter((message) => message.role === "user" && message.kind === "context.compaction"),
    ).toHaveLength(1);
    expect(second!.at(-2)).toEqual(user("fourth ask"));
  });

  it("keeps the newest person messages within the budget, truncating the one that overflows", async () => {
    const { ctx } = fakeContext({ limit: 100_000 });
    const result = await compactOf(codexCompaction({ userMessageBudget: 60 }))(history, ctx);
    const kept = result!.slice(0, -1);
    expect(kept).toHaveLength(2);
    expect(kept[1]).toEqual(user("third ask"));
    expect((kept[0]!.content as string).startsWith("second ask")).toBe(true);
    expect((kept[0]!.content as string).length).toBeLessThan(
      (history[5]!.content as string).length,
    );
  });

  it("drops the oldest item, with its result, while the summary request overflows", async () => {
    const { ctx, calls } = fakeContext({ limit: 100_000, summaryLimit: 200 });
    await compactOf(codexCompaction())(history, ctx);
    const sent = calls.at(-1)!.messages;
    expect(calls.length).toBeGreaterThan(1);
    expect(pairsIntact(sent)).toBe(true);
    expect(ids(sent)).not.toContain("call-1");
  });

  it("is due at a step at 90% of the window, or the configured limit below it", () => {
    const base = { phase: "step" as const, threshold: 150_000, contextWindowTokens: 200_000 };
    expect(dueOf(codexCompaction())({ ...base, inputTokens: 179_999 })).toBe(false);
    expect(dueOf(codexCompaction())({ ...base, inputTokens: 180_000 })).toBe(true);
    const limited = dueOf(codexCompaction({ autoCompactTokenLimit: 100_000 }));
    expect(limited({ ...base, inputTokens: 100_000 })).toBe(true);
    const aboveCap = dueOf(codexCompaction({ autoCompactTokenLimit: 195_000 }));
    expect(aboveCap({ ...base, inputTokens: 185_000 })).toBe(true);
  });

  it("is due at turn end only with a post-turn share, of the 95% usable window", () => {
    const base = { phase: "turn-end" as const, threshold: 190_000, contextWindowTokens: 200_000 };
    expect(dueOf(codexCompaction())({ ...base, inputTokens: 189_000 })).toBe(false);
    const due = dueOf(codexCompaction({ postTurnPercent: 0.5 }));
    expect(due({ ...base, inputTokens: 94_999 })).toBe(false);
    expect(due({ ...base, inputTokens: 95_000 })).toBe(true);
  });
});
