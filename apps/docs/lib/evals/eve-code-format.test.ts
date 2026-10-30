import { describe, expect, it } from "vitest";
import { renderBenchmarkMarkdown } from "./eve-code-format";
import type { EveCodeDatasetResults, EveCodeHarnessScore } from "./eve-code-results";

const score: EveCodeHarnessScore = {
  harness: "alice",
  version: null,
  resolved: 2,
  attempts: 3,
  resolveRate: { estimate: 2 / 3, low: 0.5, high: 0.8 },
  costUsd: null,
  costPerResolvedUsd: null,
  inputTokens: 0,
  outputTokens: 0,
  cachedShare: null,
  latencyP50Ms: 1250,
  latencyP90Ms: 2400,
  source: null,
  runUrl: null,
  measuredAt: "2026-10-03T12:00:00Z",
};

const results: EveCodeDatasetResults = {
  dataset: { name: "example", version: "v1" },
  model: { id: "example-model" },
  attempts: 3,
  tasks: 1,
  generatedAt: "2026-10-04T12:00:00Z",
  harnesses: [
    { ...score, harness: "bob", latencyP50Ms: 2000, measuredAt: null },
    {
      ...score,
      harness: "charlie",
      resolveRate: { estimate: 0.5, low: 0.2, high: 0.7 },
      latencyP50Ms: 500,
    },
    score,
  ],
};

describe("benchmark Markdown table", () => {
  it("formats the snapshot and orders by resolve rate, then latency", () => {
    expect(renderBenchmarkMarkdown(results, "example")).toBe(
      [
        "1 tasks × 3 attempts on `example-model`. Snapshot updated 2026-10-04.",
        "",
        "| Harness | Resolved | 95% interval | Median latency | p90 latency | Measured |",
        "| --- | --- | --- | --- | --- | --- |",
        "| `alice` | 67% (2/3) | 50%–80% | 1.3s | 2.4s | 2026-10-03 |",
        "| `bob` | 67% (2/3) | 50%–80% | 2.0s | 2.4s | — |",
        "| `charlie` | 50% (2/3) | 20%–70% | 0.5s | 2.4s | 2026-10-03 |",
      ].join("\n"),
    );
  });
});
