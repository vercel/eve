import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { JUnit } from "#evals/reporters/index.js";
import type { EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => fsMocks);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("JUnit", () => {
  it("writes one testsuite with passed and failed evals as JUnit XML", async () => {
    const reporter = JUnit({ filePath: "/tmp/eve/junit.xml", suiteName: "suite & one" });

    await reporter.onRunComplete(makeSummary());

    expect(fsMocks.mkdir).toHaveBeenCalledWith("/tmp/eve", { recursive: true });
    expect(fsMocks.writeFile).toHaveBeenCalledOnce();
    const [, xml] = fsMocks.writeFile.mock.calls[0]!;
    expect(xml).toContain('<testsuite name="suite &amp; one" tests="2" failures="1" skipped="0"');
    expect(xml).toContain('<testcase classname="eve.eval" name="runtime/passes"');
    expect(xml).toContain('<failure message="contains: expected hello">');
  });

  it("defaults the suite name", async () => {
    const reporter = JUnit({ filePath: "/tmp/eve/junit.xml" });

    await reporter.onRunComplete(makeSummary());

    const [, xml] = fsMocks.writeFile.mock.calls[0]!;
    expect(xml).toContain('<testsuite name="eve evals" tests="2" failures="1" skipped="0"');
  });
});

function makeSummary(): EveEvalRunSummary {
  return {
    results: [
      makeEvalResult({ id: "runtime/passes", verdict: "passed" }),
      makeEvalResult({
        id: "runtime/fails",
        assertions: [
          {
            name: "contains",
            score: 0,
            severity: "gate",
            passed: false,
            message: "expected hello",
          },
        ],
        verdict: "failed",
      }),
    ],
    completedAt: "2026-01-01T00:00:02.000Z",
    errored: 0,
    failed: 1,
    passed: 1,
    scored: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    target: makeTarget(),
  };
}

function makeEvalResult(overrides: Partial<EveEvalResult> = {}): EveEvalResult {
  return {
    id: "eval-1",
    assertions: [{ name: "check", score: 1, severity: "gate", passed: true }],
    result: {
      derived: createEmptyDerivedFacts(),
      events: [],
      finalMessage: "done",
      output: "done",
      status: "completed",
    },
    verdict: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function makeTarget(): EveEvalTarget {
  return {
    capabilities: { devRoutes: true },
    kind: "local",
    url: "http://127.0.0.1:3000",
  };
}
