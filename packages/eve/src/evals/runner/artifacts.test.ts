import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { writeArtifacts } from "#evals/runner/artifacts.js";
import type { EveEvalResult, EveEvalRunSummary } from "#evals/types.js";

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => fsMocks);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("eval artifacts", () => {
  it("persists skipped counts and reasons in every JSON artifact", async () => {
    await writeArtifacts("/tmp/eve-evals", skippedSummary());

    const summary = writtenJson("/tmp/eve-evals/summary.json");
    expect(summary).toMatchObject({
      skipped: 1,
      evals: [{ id: "runtime/skipped", skipReason: "dev routes unavailable" }],
    });

    const result = writtenJson("/tmp/eve-evals/results.jsonl");
    expect(result).toMatchObject({
      id: "runtime/skipped",
      skipReason: "dev routes unavailable",
    });

    const detail = writtenJson("/tmp/eve-evals/evals/runtime/skipped.json");
    expect(detail).toMatchObject({
      id: "runtime/skipped",
      skipReason: "dev routes unavailable",
    });
  });
});

function writtenJson(path: string): Record<string, unknown> {
  const call = fsMocks.writeFile.mock.calls.find(([writtenPath]) => writtenPath === path);
  expect(call, `expected ${path} to be written`).toBeDefined();
  return JSON.parse(call?.[1] as string) as Record<string, unknown>;
}

function skippedSummary(): EveEvalRunSummary {
  const result: EveEvalResult = {
    id: "runtime/skipped",
    assertions: [],
    result: {
      derived: createEmptyDerivedFacts(),
      events: [],
      finalMessage: null,
      output: null,
      status: "completed",
    },
    verdict: "skipped",
    skipReason: "dev routes unavailable",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
  return {
    target: { capabilities: { devRoutes: true }, kind: "local", url: "http://localhost:3000" },
    results: [result],
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    passed: 0,
    failed: 0,
    scored: 0,
    skipped: 1,
    errored: 0,
  };
}
