import { describe, expect, it } from "vitest";

import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { consoleReporter } from "#evals/runner/reporters/console.js";
import type { EveEvalResult, EveEvalRunSummary } from "#evals/types.js";

describe("consoleReporter", () => {
  it("reports skipped evals and their reason", () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ color: false, log: (line) => lines.push(line) });
    const result = skippedResult();

    reporter.onEvalComplete(result);
    reporter.onRunComplete(summary(result));

    expect(lines.join("\n")).toContain("dev routes unavailable");
    expect(lines.join("\n")).toContain("1 skipped");
  });

  it("indents multiline assertion failure details", () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ color: false, log: (line) => lines.push(line) });

    reporter.onEvalComplete({
      assertions: [
        {
          message: [
            'state: {"input":"Name the source."}',
            'question: {"type":"boolean","instructions":"cites a source"}',
            'answer: {"type":"boolean","probability":0}',
          ].join("\n"),
          name: "judge.boolean",
          passed: false,
          errored: false,
          score: 0,
          severity: "soft",
          threshold: 0.8,
        },
      ],
      completedAt: "2026-01-01T00:00:01.000Z",
      id: "sourcing",
      result: {
        sessionEnded: false,
        derived: createEmptyDerivedFacts(),
        events: [],
        reply: "No source.",
        data: "No source.",
        status: "completed",
        traceContexts: [],
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      verdict: "scored",
    });

    expect(lines).toContain('  ✗ judge.boolean (0% < 80%): state: {"input":"Name the source."}');
    expect(lines).toContain('    question: {"type":"boolean","instructions":"cites a source"}');
    expect(lines).toContain('    answer: {"type":"boolean","probability":0}');
  });

  it("warns when repeated soft assertions merge different scores and leaves gates quiet", () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ color: false, log: (line) => lines.push(line) });

    reporter.onEvalComplete({
      assertions: [
        { name: "judge.boolean", passed: true, errored: false, score: 0.9, severity: "soft" },
        { name: "judge.boolean", passed: true, errored: false, score: 0.4, severity: "soft" },
        { name: "judge.boolean", passed: true, errored: false, score: 1, severity: "gate" },
        { name: "succeeded", passed: true, errored: false, score: 1, severity: "gate" },
        {
          name: "succeeded",
          passed: false,
          errored: false,
          score: 0,
          severity: "gate",
          threshold: 1,
        },
      ],
      completedAt: "2026-01-01T00:00:01.000Z",
      id: "quality",
      result: {
        sessionEnded: false,
        derived: createEmptyDerivedFacts(),
        events: [],
        reply: "ok",
        data: "ok",
        status: "completed",
        traceContexts: [],
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      verdict: "failed",
    });

    expect(lines).toEqual([
      "✗  quality  gates 2/3  judge.boolean: 90%  judge.boolean: 40%",
      "  ✗ succeeded (0% < 100%)",
      "  ⚠ judge.boolean recorded 2 times with different scores; Braintrust and Datadog keep only the lowest. Add .label() to tell them apart.",
    ]);
  });

  it("aggregates repeated soft scores as one value per eval in the run summary", () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ color: false, log: (line) => lines.push(line) });
    const result: EveEvalResult = {
      assertions: [
        { name: "judge.boolean", passed: true, errored: false, score: 0.9, severity: "soft" },
        { name: "judge.boolean", passed: true, errored: false, score: 0.4, severity: "soft" },
      ],
      completedAt: "2026-01-01T00:00:01.000Z",
      id: "quality",
      result: {
        sessionEnded: false,
        derived: createEmptyDerivedFacts(),
        events: [],
        reply: "ok",
        data: "ok",
        status: "completed",
        traceContexts: [],
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      verdict: "passed",
    };

    reporter.onRunComplete(summary(result));

    expect(lines).toContain("  judge.boolean: 40% (1 evals)");
  });

  it("summarizes repeated attempts as a gate pass rate per eval", () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ color: false, log: (line) => lines.push(line) });
    const verdicts = [
      ["flaky", "passed"],
      ["flaky", "failed"],
      ["flaky", "skipped"],
      ["stable", "passed"],
      ["stable", "passed"],
      ["judged", "scored"],
    ] as const;
    const results = verdicts.map(([id, verdict], index): EveEvalResult => ({
      ...skippedResult(),
      id,
      attempt: index + 1,
      verdict,
    }));

    reporter.onRunComplete({ ...summary(results[0] ?? skippedResult()), results });

    const start = lines.indexOf("Repeatability:");
    expect(lines.slice(start, start + 3)).toEqual([
      "Repeatability:",
      "  1/2 passed  flaky",
      "  2/2 passed  stable",
    ]);
    expect(lines.join("\n")).not.toContain("judged");
  });

  it("does not print diagnostics for passing assertions", () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ color: false, log: (line) => lines.push(line) });

    reporter.onEvalComplete({
      assertions: [
        {
          message: 'prompt: "Successful prompt details"',
          metadata: { rationale: "Successful rationale details" },
          name: "judge.boolean",
          passed: true,
          errored: false,
          score: 1,
          severity: "gate",
        },
      ],
      completedAt: "2026-01-01T00:00:01.000Z",
      id: "sourcing",
      result: {
        sessionEnded: false,
        derived: createEmptyDerivedFacts(),
        events: [],
        reply: "A sourced answer.",
        data: "A sourced answer.",
        status: "completed",
        traceContexts: [],
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      verdict: "passed",
    });

    expect(lines).toEqual(["✓  sourcing  gates 1/1"]);
  });
});

function skippedResult(): EveEvalResult {
  return {
    assertions: [],
    completedAt: "2026-01-01T00:00:01.000Z",
    id: "schedule",
    result: {
      sessionEnded: false,
      derived: createEmptyDerivedFacts(),
      events: [],
      reply: undefined,
      data: null,
      status: "completed",
      traceContexts: [],
    },
    skipReason: "dev routes unavailable",
    startedAt: "2026-01-01T00:00:00.000Z",
    verdict: "skipped",
  };
}

function summary(result: EveEvalResult): EveEvalRunSummary {
  return {
    completedAt: result.completedAt,
    errored: 0,
    failed: 0,
    passed: 0,
    results: [result],
    scored: 0,
    skipped: 1,
    startedAt: result.startedAt,
    target: { capabilities: { devRoutes: false }, kind: "remote", url: "https://eve.test" },
  };
}
