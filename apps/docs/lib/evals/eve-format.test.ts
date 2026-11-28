import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  formatDurationMs,
  formatMedianCount,
  formatPercent,
  formatSignedDelta,
  formatTokens,
  formatUsd,
  renderBenchmarkMarkdown,
  renderBenchmarksPageMarkdown,
} from "./eve-format";
import type { EveDatasetResults, EveHarnessScore } from "./eve-results";

const execFileAsync = promisify(execFile);

const score: EveHarnessScore = {
  harness: "alice",
  version: "1.0.0",
  resolved: 2,
  attempts: 3,
  resolveRate: { estimate: 2 / 3, low: 0.5, high: 0.8 },
  passAllTasks: 1,
  passAllRate: 1,
  costUsd: 1.25,
  costPerResolvedUsd: 0.625,
  inputTokens: 1_500_000,
  outputTokens: 25_000,
  cachedShare: 0.942,
  latencyP50Ms: 125_000,
  latencyP90Ms: 240_000,
  overhead: {
    firstStepInputTokens: 2100,
    modelStepsMedian: 18,
    toolCallsMedian: 24,
    topTools: [{ name: "bash", count: 72 }],
  },
  effectsVsEve: null,
  source: null,
  runUrl: null,
  measuredAt: "2026-10-03T12:00:00Z",
};

const results: EveDatasetResults = {
  models: {
    anthropic: {
      dataset: { name: "example", version: "v1" },
      family: "anthropic",
      model: { id: "anthropic/example-sonnet" },
      attempts: 3,
      tasks: 1,
      reasoning: "high",
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
          resolved: 0,
          resolveRate: { estimate: 0, low: 0, high: 0.2 },
          passAllTasks: 0,
          passAllRate: 0,
          costUsd: 0.9,
          costPerResolvedUsd: null,
          latencyP50Ms: 50_000,
        },
        score,
      ],
      taskMatrix: [
        {
          task: "sample-task",
          cells: {
            alice: {
              resolved: 2,
              attempts: 3,
              latencyMs: 125_000,
              inputTokens: 500_000,
              outputTokens: 8_000,
            },
            bob: {
              resolved: 2,
              attempts: 3,
              latencyMs: 200_000,
              inputTokens: 500_000,
              outputTokens: 8_000,
            },
          },
        },
      ],
    },
    openai: {
      dataset: { name: "example", version: "v1" },
      family: "openai",
      model: { id: "openai/example-gpt" },
      attempts: 5,
      tasks: 1,
      reasoning: "high",
      generatedAt: "2026-10-05T12:00:00Z",
      runUrl: null,
      harnesses: [{ ...score, attempts: 5 }],
      taskMatrix: [
        {
          task: "sample-task",
          cells: {
            alice: {
              resolved: 5,
              attempts: 5,
              latencyMs: 90_000,
              inputTokens: 400_000,
              outputTokens: 7_000,
            },
          },
        },
      ],
    },
  },
};

describe("benchmark formatting and Markdown export", () => {
  it("formats durations, tokens, currency, percentages, counts, and signed deltas", () => {
    expect(formatDurationMs(1250)).toBe("1.3s");
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(239_000)).toBe("3m 59s");
    expect(formatDurationMs(null)).toBe("—");
    expect(formatTokens(1514.5)).toBe("1.5K");
    expect(formatTokens(928_000)).toBe("928K");
    expect(formatTokens(73_431_985)).toBe("73.4M");
    expect(formatPercent(0.939, 1)).toBe("93.9%");
    expect(formatUsd(1.25)).toBe("$1.25");
    expect(formatMedianCount(18.5)).toBe("18.5");
    expect(formatSignedDelta(0.2, "%")).toBe("±0%");
    expect(formatSignedDelta(-0.2, "%")).toBe("±0%");
    expect(formatSignedDelta(-11.4, " pp")).toBe("−11 pp");
  });

  it("renders models in family order, derives pass^k from attempts, and handles null costPerResolvedUsd", () => {
    const md = renderBenchmarkMarkdown(results, "example");
    const openaiIdx = md.indexOf("### OpenAI (`openai/example-gpt`)");
    const anthropicIdx = md.indexOf("### Anthropic (`anthropic/example-sonnet`)");
    expect(openaiIdx).toBeGreaterThanOrEqual(0);
    expect(anthropicIdx).toBeGreaterThan(openaiIdx);
    expect(md).toContain("| pass^5 |");
    expect(md).toContain("| pass^3 |");
    expect(md).toContain(
      "| `alice@1.0.0` | 67% (2/3) | 50%–80% | 100% | 2m 05s / 4m 00s | 1.5M / 25K | 94.2% | 2.1K | 18 / 24 | $1.25 ($0.63/res) |",
    );
    expect(md).toContain(
      "| `bob` | 67% (2/3) | 50%–80% | 100% | 3m 20s / 4m 00s | 1.5M / 25K | 94.2% | — | — | — |",
    );
    expect(md).toContain(
      "| `charlie@1.0.0` | 0% (0/3) | 0%–20% | 0% | 50s / 4m 00s | 1.5M / 25K | 94.2% | 2.1K | 18 / 24 | $0.90 |",
    );
    expect(md).not.toContain("—/res");
    expect(renderBenchmarkMarkdown(undefined, "missing")).toBe("No published missing results yet.");
  });

  it("nests each model's per-task matrix under its own heading in the full page Markdown", () => {
    const page = renderBenchmarksPageMarkdown(results, [], null);
    const openaiH3 = page.indexOf("### OpenAI");
    const openaiTasksH4 = page.indexOf("#### Per-task pass rate — OpenAI");
    const anthropicH3 = page.indexOf("### Anthropic");
    const anthropicTasksH4 = page.indexOf("#### Per-task pass rate — Anthropic");
    expect(page).toContain("## Harness Benchmarks (`example@v1`)");
    expect(openaiH3).toBeGreaterThan(-1);
    expect(openaiTasksH4).toBeGreaterThan(openaiH3);
    expect(anthropicH3).toBeGreaterThan(openaiTasksH4);
    expect(anthropicTasksH4).toBeGreaterThan(anthropicH3);
  });

  it("loads directly under native Node.js ESM for packages/eve/scripts/copy-docs.mjs", async () => {
    const modulePath = fileURLToPath(new URL("./eve-format.ts", import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [
      "-e",
      `import(${JSON.stringify(modulePath)}).then((m) => console.log(typeof m.renderBenchmarkMarkdown, typeof m.orderedModels))`,
    ]);
    expect(stdout.trim()).toBe("function function");
  });
});
