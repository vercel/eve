import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { compactionConfig } from "#harness/compaction/config.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const step = (input: { readonly window?: number; readonly thresholdPercent?: number }) => ({
  ctx: agentContext(input.thresholdPercent),
  model: {
    reference:
      input.window === undefined ? { id: "m" } : { contextWindowTokens: input.window, id: "m" },
  },
  session: { compaction: { lastKnownInputTokens: 321, lastKnownPromptMessageCount: 7 } },
});

describe("compactionConfig", () => {
  it("compacts past a share of the model's context window", () => {
    expect(compactionConfig(step({ window: 1_000_000 }))).toEqual({
      lastKnownInputTokens: 321,
      lastKnownPromptMessageCount: 7,
      recentWindowSize: 10,
      target: 500_000,
      threshold: 900_000,
      thresholdPercent: 0.9,
    });
    expect(compactionConfig(step({ thresholdPercent: 0.5, window: 200_000 }))).toMatchObject({
      threshold: 100_000,
      thresholdPercent: 0.5,
    });
  });

  it("compacts past 100k tokens for a model whose window it doesn't know", () => {
    expect(compactionConfig(step({})).threshold).toBe(100_000);
  });

  it("compacts down to half the window, never above the threshold", () => {
    expect(compactionConfig(step({ window: 200_000 })).target).toBe(100_000);
    expect(compactionConfig(step({ thresholdPercent: 0.4, window: 200_000 })).target).toBe(80_000);
    expect(compactionConfig(step({})).target).toBe(50_000);
  });
});

function agentContext(thresholdPercent: number | undefined): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    resolvedAgent: { config: { compaction: { thresholdPercent } } },
    turnAgent: {},
  } as never);
  return ctx;
}
