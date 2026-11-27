import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { compactionConfig } from "#harness/compaction/config.js";
import { withPromptMeasurement } from "#harness/compaction/engine.js";
import { shouldCompact } from "#internal/testing/compaction-trigger.js";
import type { CompactionState } from "#harness/types.js";

const step = (window?: number) => ({
  ctx: new ContextContainer(),
  model: {
    reference: window === undefined ? { id: "m" } : { contextWindowTokens: window, id: "m" },
  },
  session: { compaction: { lastKnownInputTokens: 321, lastKnownPromptMessageCount: 7 } },
});

describe("compactionConfig", () => {
  it("returns the session's measurement and the model's context window", () => {
    expect(compactionConfig(step(1_000_000))).toEqual({
      contextWindowTokens: 1_000_000,
      lastKnownInputTokens: 321,
      lastKnownPromptMessageCount: 7,
    });
  });

  it("leaves the window out for a model whose window it doesn't know", () => {
    expect(compactionConfig(step())).toEqual({
      lastKnownInputTokens: 321,
      lastKnownPromptMessageCount: 7,
    });
  });

  it("counts the prompt with the step model's own measurement after the session switched models", () => {
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
      ctx: new ContextContainer(),
      model: { reference: { contextWindowTokens: 1_000_000, id } },
      session: { compaction },
    });

    const prompt = { messages, requestEnvelopeTokens: 0 };
    const threshold = 200_000;
    const due = (id: string) =>
      shouldCompact(messages, { ...compactionConfig(on(id), prompt), threshold });
    expect(due("provider/model-b")).toBe(false);
    expect(due("provider/model-a")).toBe(true);
    expect(compactionConfig(on("provider/model-c"))).toMatchObject({
      lastKnownInputTokens: 145_000,
      lastKnownPromptMessageCount: 6,
    });
  });

  it("compares complete baselines with their own envelope before selecting the larger count", () => {
    const messages = [{ content: "Alice's report.", role: "user" as const }];
    let compaction = withPromptMeasurement(
      {},
      {
        inputTokens: 190_000,
        modelId: "model-a",
        promptMessageCount: 1,
        requestEnvelopeTokens: 90_000,
      },
    );
    compaction = withPromptMeasurement(compaction, {
      inputTokens: 145_000,
      modelId: "model-b",
      promptMessageCount: 1,
      requestEnvelopeTokens: 1_000,
    });
    const config = compactionConfig(
      {
        ctx: new ContextContainer(),
        model: { reference: { contextWindowTokens: 250_000, id: "model-a" } },
        session: { compaction },
      },
      { messages, requestEnvelopeTokens: 100_000 },
    );

    expect(config).toMatchObject({
      lastKnownInputTokens: 145_000,
      lastKnownPromptMessageCount: 1,
      requestEnvelopeTokens: 1_000,
    });
    expect(
      shouldCompact(
        messages,
        { ...config, threshold: 225_000 },
        100_000,
        config.requestEnvelopeTokens,
      ),
    ).toBe(true);
  });
});
