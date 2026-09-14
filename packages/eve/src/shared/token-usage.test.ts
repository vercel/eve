import { describe, expect, it } from "vitest";

import { addTokenUsage } from "#shared/add-token-usage.js";
import type { TokenUsage } from "#shared/token-usage.js";

describe("addTokenUsage", () => {
  it("preserves whether model cost was reported", () => {
    expect(addTokenUsage(usage(3, 1, 0.25), usage(5, 2))).toEqual(usage(8, 3, 0.25));
    expect(addTokenUsage(usage(3, 1), usage(5, 2))).toEqual(usage(8, 3));
  });
});

function usage(inputTokens: number, outputTokens: number, costUsd?: number): TokenUsage {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    inputTokens,
    outputTokens,
  };
}
