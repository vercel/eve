import { describe, expect, it } from "vitest";

import { usageSince } from "#shared/token-usage-math.js";

const counts = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

describe("usageSince", () => {
  it("is the whole total before anything was counted", () => {
    const total = { ...counts, costUsd: 0.5, inputTokens: 10 };
    expect(usageSince(total, undefined)).toBe(total);
  });

  it("subtracts what was counted, and its cost once the total has one", () => {
    expect(
      usageSince(
        { ...counts, costUsd: 0.5, inputTokens: 30, outputTokens: 8 },
        { ...counts, inputTokens: 10, outputTokens: 3 },
      ),
    ).toEqual({ ...counts, costUsd: 0.5, inputTokens: 20, outputTokens: 5 });
    expect(usageSince({ ...counts, inputTokens: 4 }, { ...counts, inputTokens: 1 })).toEqual({
      ...counts,
      costUsd: undefined,
      inputTokens: 3,
    });
  });
});
