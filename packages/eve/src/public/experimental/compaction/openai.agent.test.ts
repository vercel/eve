import { describe, expect, it } from "vitest";

import { defineAgent } from "#public/definitions/agent.js";
import { defaultCompaction, openaiCompaction } from "#public/experimental/compaction/index.js";

describe("openaiCompaction() on defineAgent", () => {
  it("accepts an openai/ AI Gateway id, alone or with a fallback", () => {
    defineAgent({
      experimental: { compaction: openaiCompaction() },
      model: "openai/gpt-5.4",
    });
    defineAgent({
      experimental: {
        compaction: {
          fallback: defaultCompaction({ threshold: 0.8 }),
          strategy: openaiCompaction(),
        },
      },
      model: "openai/gpt-5.4",
    });
  });

  it("rejects another provider's AI Gateway id in the type", () => {
    defineAgent({
      // @ts-expect-error openaiCompaction() fits only "openai/..." ids.
      experimental: { compaction: openaiCompaction() },
      model: "anthropic/claude-opus-4-6",
    });
    expect(true).toBe(true);
  });
});
