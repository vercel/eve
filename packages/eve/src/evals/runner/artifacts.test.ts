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
  it("persists trace contexts in summary, index, and detail artifacts", async () => {
    await writeArtifacts("/tmp/eve-evals", judgedSummary());

    const expected = [
      {
        primary: true,
        sessionId: "session-1",
        spanId: "0123456789abcdef",
        traceFlags: 1,
        traceId: "0123456789abcdef0123456789abcdef",
      },
    ];
    expect(writtenJson("/tmp/eve-evals/summary.json")).toMatchObject({
      evals: [{ caseId: "case-1", traceContexts: expected }],
      runId: "run-1",
    });
    expect(writtenJson("/tmp/eve-evals/results.jsonl")).toMatchObject({
      caseId: "case-1",
      runId: "run-1",
      traceContexts: expected,
    });
    expect(writtenJson("/tmp/eve-evals/evals/quality/source.json")).toMatchObject({
      caseId: "case-1",
      result: { traceContexts: expected },
      runId: "run-1",
    });
  });

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

  it("keeps assertion diagnostics in the run summary", async () => {
    await writeArtifacts("/tmp/eve-evals", judgedSummary());

    const summary = writtenJson("/tmp/eve-evals/summary.json");
    expect(summary).toMatchObject({
      evals: [
        {
          assertions: [
            {
              message: 'prompt: "Name the source."',
              metadata: {
                criteria: "cites a source",
                input: "Name the source.",
                rationale: "No source was cited.",
              },
              name: "judge.autoevals.closedQA",
              passed: false,
              score: 0,
              severity: "soft",
              threshold: 0.8,
            },
          ],
          id: "quality/source",
          verdict: "scored",
        },
      ],
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
    caseId: "case-1",
    id: "runtime/skipped",
    runId: "run-1",
    assertions: [],
    result: {
      derived: createEmptyDerivedFacts(),
      events: [],
      finalMessage: null,
      output: null,
      status: "completed",
      traceContexts: [],
    },
    verdict: "skipped",
    skipReason: "dev routes unavailable",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
  return {
    runId: "run-1",
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

function judgedSummary(): EveEvalRunSummary {
  const result: EveEvalResult = {
    caseId: "case-1",
    id: "quality/source",
    runId: "run-1",
    assertions: [
      {
        name: "judge.autoevals.closedQA",
        score: 0,
        severity: "soft",
        threshold: 0.8,
        passed: false,
        message: 'prompt: "Name the source."',
        metadata: {
          criteria: "cites a source",
          input: "Name the source.",
          rationale: "No source was cited.",
        },
      },
    ],
    result: {
      derived: createEmptyDerivedFacts(),
      events: [],
      finalMessage: "No source.",
      output: "No source.",
      status: "completed",
      traceContexts: [
        {
          primary: true,
          sessionId: "session-1",
          spanId: "0123456789abcdef",
          traceFlags: 1,
          traceId: "0123456789abcdef0123456789abcdef",
        },
      ],
    },
    verdict: "scored",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
  return {
    runId: "run-1",
    target: { capabilities: { devRoutes: true }, kind: "local", url: "http://localhost:3000" },
    results: [result],
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    passed: 0,
    failed: 0,
    scored: 1,
    skipped: 0,
    errored: 0,
  };
}
