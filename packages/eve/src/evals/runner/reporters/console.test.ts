import { describe, expect, it } from "vitest";

import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { Console } from "#evals/runner/reporters/console.js";
import type { EveEvalResult, EveEvalRunSummary } from "#evals/types.js";

describe("Console", () => {
  it("reports skipped evals and their reason", () => {
    const lines: string[] = [];
    const reporter = Console({ color: false, log: (line) => lines.push(line) });
    const result = skippedResult();

    reporter.onEvalComplete(result);
    reporter.onRunComplete(summary(result));

    expect(lines.join("\n")).toContain("dev routes unavailable");
    expect(lines.join("\n")).toContain("1 skipped");
  });
});

function skippedResult(): EveEvalResult {
  return {
    assertions: [],
    completedAt: "2026-01-01T00:00:01.000Z",
    id: "schedule",
    result: {
      derived: createEmptyDerivedFacts(),
      events: [],
      finalMessage: null,
      output: null,
      status: "completed",
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
