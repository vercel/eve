import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { compactionConfig } from "#harness/compaction/config.js";
import { shouldCompact, withPromptMeasurement } from "#harness/compaction/engine.js";
import type { CompactionState } from "#harness/types.js";
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

  it("counts the prompt with the step model's own measurement after the session switched models", () => {
    // Tokenizers differ: model A counts the same history well above model B. A turn on A must
    // not judge the history by B's smaller count, or the threshold is first crossed by A's
    // own step and the history is rewritten in the middle of the turn.
    const bulk = (text: string) => ({ content: text.repeat(48_000), role: "user" as const });
    const messages = [
      ...["a", "b", "c", "d"].map((text) => ({ content: text, role: "user" as const })),
      ...["e", "f", "g", "h"].map(bulk),
    ];
    let compaction: CompactionState = {};
    compaction = withPromptMeasurement(compaction, {
      inputTokens: 190_000,
      modelId: "provider/model-a",
      promptMessageCount: 4,
    });
    compaction = withPromptMeasurement(compaction, {
      inputTokens: 145_000,
      modelId: "provider/model-b",
      promptMessageCount: 6,
    });
    const on = (id: string) => ({
      ctx: agentContext(0.2),
      model: { reference: { contextWindowTokens: 1_000_000, id } },
      session: { compaction },
    });

    expect(shouldCompact(messages, compactionConfig(on("provider/model-b")))).toBe(false);
    expect(shouldCompact(messages, compactionConfig(on("provider/model-a")))).toBe(true);
    // A model that never measured this history keeps the latest measurement.
    expect(compactionConfig(on("provider/model-c"))).toMatchObject({
      lastKnownInputTokens: 145_000,
      lastKnownPromptMessageCount: 6,
    });
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
