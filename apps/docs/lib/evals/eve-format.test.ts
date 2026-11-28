import { describe, expect, it } from "vitest";
import { formatDurationMs, formatTokens, renderBenchmarkMarkdown } from "./eve-format";
import type { EveDatasetResults, EveHarnessScore } from "./eve-results";

const score: EveHarnessScore = {
  harness: "alice",
  version: "1.0.0",
  resolved: 2,
  attempts: 3,
  resolveRate: { estimate: 2 / 3, low: 0.5, high: 0.8 },
  passAllTasks: 1,
  passAllRate: 1,
  costUsd: 1.25,
  medianCostUsd: 0.42,
  costPerResolvedUsd: 0.625,
  inputTokens: 1_500_000,
  outputTokens: 25_000,
  cachedShare: 0.942,
  latencyP50Ms: 125_000,
  latencyP90Ms: 240_000,
  overhead: {
    firstStepInputTokens: 2100,
    modelStepsMedian: 18,
    modelStepsTotal: 54,
    toolCallsMedian: 24,
    toolCallsTotal: 72,
    topTools: [{ name: "bash", count: 72 }],
  },
  effectsVsEve: null,
  source: null,
  runUrl: null,
  measuredAt: "2026-10-03T12:00:00Z",
};

const results: EveDatasetResults = {
  dataset: { name: "example", version: "v1" },
  attempts: 3,
  tasks: 1,
  reasoning: "high",
  models: {
    anthropic: {
      family: "anthropic",
      model: { id: "anthropic/example-sonnet" },
      generatedAt: "2026-10-04T12:00:00Z",
      runUrl: null,
      harnesses: [
        {
          ...score,
          harness: "bob",
          version: null,
          latencyP50Ms: 200_000,
          costUsd: null,
          costPerResolvedUsd: null,
          overhead: null,
        },
        {
          ...score,
          harness: "charlie",
          resolveRate: { estimate: 0.5, low: 0.2, high: 0.7 },
          passAllRate: 0,
          latencyP50Ms: 50_000,
        },
        score,
      ],
      taskMatrix: [],
    },
    openai: {
      family: "openai",
      model: { id: "openai/example-gpt" },
      generatedAt: "2026-10-05T12:00:00Z",
      runUrl: null,
      harnesses: [score],
      taskMatrix: [],
    },
  },
};

describe("benchmark formatting and Markdown export", () => {
  it("formats durations and token counts compactly", () => {
    expect(formatDurationMs(1250)).toBe("1.3s");
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(239_000)).toBe("3m 59s");
    expect(formatTokens(1514.5)).toBe("1.5K");
    expect(formatTokens(928_000)).toBe("928K");
    expect(formatTokens(73_431_985)).toBe("73.4M");
  });

  it("renders models in family order (OpenAI then Anthropic) and ranks contenders by resolve rate then latency", () => {
    const md = renderBenchmarkMarkdown(results, "example");
    expect(md.indexOf("### OpenAI (`openai/example-gpt`)")).toBeGreaterThanOrEqual(0);
    expect(md.indexOf("### Anthropic (`anthropic/example-sonnet`)")).toBeGreaterThan(
      md.indexOf("### OpenAI (`openai/example-gpt`)"),
    );
    expect(md).toContain(
      "| Harness | Resolved | 95% interval | pass^3 | Latency (p50 / p90) | Tokens (in / out) | Cache hit | Step 1 prompt | Steps / tools | Cost |",
    );
    expect(md).toContain(
      "| `alice@1.0.0` | 67% (2/3) | 50%–80% | 100% | 2m 05s / 4m 00s | 1.5M / 25K | 94.2% | 2.1K | 18 / 24 | $1.25 ($0.63/res) |",
    );
    expect(md).toContain(
      "| `bob` | 67% (2/3) | 50%–80% | 100% | 3m 20s / 4m 00s | 1.5M / 25K | 94.2% | — | — | — |",
    );
    expect(md.indexOf("`alice@1.0.0`", md.indexOf("### Anthropic"))).toBeLessThan(
      md.indexOf("`bob`", md.indexOf("### Anthropic")),
    );
  });
});
