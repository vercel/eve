import { describe, expect, it, vi } from "vitest";

import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { Datadog, type DatadogReporterConfig } from "#evals/reporters/index.js";
import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";

function makeTarget(kind: "local" | "remote" = "local"): EveEvalTarget {
  return {
    capabilities: { devRoutes: kind === "local" },
    kind,
    url: kind === "local" ? "http://127.0.0.1:3000" : "https://test.vercel.app",
  };
}

function makeEval(overrides: Partial<EveEval> = {}): EveEval {
  return {
    _tag: "EveEval",
    id: "eval-1",
    description: "Say hello",
    tags: ["smoke"],
    metadata: { suite: "unit", expectedOutput: "helpful onboarding answer" },
    async test() {},
    ...overrides,
  };
}

function makeEvalResult(overrides: Partial<EveEvalResult> = {}): EveEvalResult {
  return {
    id: "eval-1",
    result: {
      output: "actual output",
      finalMessage: "actual output",
      status: "completed",
      events: [
        {
          type: "message.received",
          data: {
            message: "What should I send you?",
            sequence: 1,
            turnId: "turn-1",
          },
        },
      ],
      derived: {
        ...createEmptyDerivedFacts(),
        toolCalls: [
          {
            name: "search",
            input: { query: "test" },
            output: null,
            status: "completed",
            turnIndex: 0,
            sessionId: "session-123",
          },
        ],
        toolCallCount: 1,
        messageCount: 1,
      },
      sessionId: "session-123",
    },
    assertions: [
      { name: "succeeded", score: 1, severity: "gate", passed: true },
      { name: "similarity", score: 0.9, severity: "soft", threshold: 0.6, passed: true },
      { name: "judge.autoevals.closedQA", score: 1, severity: "soft", passed: true },
    ],
    verdict: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function makeSummary(result: EveEvalResult = makeEvalResult()): EveEvalRunSummary {
  return {
    target: makeTarget(),
    results: [result],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:02.000Z",
    passed: result.verdict === "passed" ? 1 : 0,
    failed: result.verdict === "failed" ? 1 : 0,
    scored: result.verdict === "scored" ? 1 : 0,
    skipped: result.verdict === "skipped" ? 1 : 0,
    errored: result.error ? 1 : 0,
  };
}

function makeConfig(overrides: Partial<DatadogReporterConfig> = {}) {
  const span = {
    experimentId: "exp-1",
    spanId: "span-1",
    traceId: "trace-1",
    url: "https://dd.test/span",
  };
  const experiment = {
    experimentId: vi.fn(() => "exp-1"),
    url: vi.fn(() => "https://dd.test/experiment"),
    submitSpan: vi.fn(async () => span),
    submitEvaluationMetrics: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const client = {
    startExperiment: vi.fn(async () => experiment),
  };
  const lines: string[] = [];
  const config = {
    projectName: "test-project",
    client,
    log: (line: string) => lines.push(line),
    ...overrides,
  } satisfies DatadogReporterConfig;

  return { client, config, lines, experiment, span };
}

describe("Datadog", () => {
  it("creates an experiment, submits one span, and attaches assertion metrics", async () => {
    const { client, config, experiment, span } = makeConfig({ experimentName: "run-1" });
    const reporter = Datadog(config);
    const evaluation = makeEval();
    const result = makeEvalResult();

    await reporter.onRunStart([evaluation], makeTarget());
    await reporter.onEvalComplete(result);

    expect(client.startExperiment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run-1",
        projectName: "test-project",
        dataset: { name: "run-1 dataset" },
        tags: expect.objectContaining({ source: "eve", target_kind: "local" }),
        metadata: expect.objectContaining({ eveEvalIds: ["eval-1"], eveTargetKind: "local" }),
      }),
    );
    expect(experiment.submitSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "eval-1",
        name: "eval-1",
        durationMs: 1000,
        metadata: expect.objectContaining({
          suite: "unit",
          eveSessionId: "session-123",
          eveVerdict: "passed",
          eveToolCalls: ["search"],
        }),
        tags: expect.objectContaining({ eval_id: "eval-1", eval_verdict: "passed" }),
      }),
    );
    expect(experiment.submitEvaluationMetrics).toHaveBeenCalledWith(span, [
      expect.objectContaining({ label: "gate_succeeded", value: 1 }),
      expect.objectContaining({ label: "similarity", value: 0.9 }),
      expect.objectContaining({ label: "judge_autoevals_closedQA", value: 1 }),
      expect.objectContaining({ label: "eve_tool_call_count", value: 1 }),
      expect.objectContaining({ label: "eve_subagent_call_count", value: 0 }),
      expect.objectContaining({ label: "eve_message_count", value: 1 }),
      expect.objectContaining({ label: "eve_reasoning_block_count", value: 0 }),
    ]);
  });

  it("records eval input and output only when enabled", async () => {
    const { config, experiment } = makeConfig({
      recordInputs: true,
      recordOutputs: true,
      recordExpectedOutputs: true,
    });
    const reporter = Datadog(config);

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onEvalComplete(makeEvalResult());

    expect(experiment.submitSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "What should I send you?",
        output: "actual output",
        expectedOutput: "helpful onboarding answer",
      }),
    );
  });

  it("closes the experiment and logs its URL", async () => {
    const { config, lines, experiment } = makeConfig();
    const reporter = Datadog(config);

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onRunComplete(makeSummary());

    expect(experiment.close).toHaveBeenCalledWith({ status: "completed", error: undefined });
    expect(lines.join("\n")).toContain("Datadog experiment URL: https://dd.test/experiment");
  });

  it("is a no-op before the experiment is initialized", async () => {
    const reporter = Datadog(makeConfig().config);

    await reporter.onEvalComplete(makeEvalResult());
    await reporter.onRunComplete(makeSummary());
  });
});
