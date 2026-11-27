import { describe, expect, it } from "vitest";

import { assertFixedPartFits } from "#public/experimental/compaction/budget.js";

describe("assertFixedPartFits", () => {
  it("passes when the fixed part leaves room, even a little (9,970 of 10,000)", () => {
    expect(() => assertFixedPartFits({ fixedTokens: 9_970, threshold: 10_000 })).not.toThrow();
  });

  it("names the system prompt, tools, memory and context when they alone reach the limit", () => {
    expect(() => assertFixedPartFits({ fixedTokens: 10_000, threshold: 10_000 })).toThrow(
      /system prompt, tools, memory and context take ~10000 tokens, over this model's ~10000-token compaction limit.*or raise the compaction threshold\.$/,
    );
  });

  it("rounds the fixed part it reports", () => {
    expect(() => assertFixedPartFits({ fixedTokens: 10_369.6, threshold: 10_000 })).toThrow(
      /take ~10370 tokens/,
    );
  });
});
