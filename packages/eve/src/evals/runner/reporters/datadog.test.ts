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
    metadata: {
      suite: "unit",
      expectedOutput: "helpful onboarding answer",
      expected: "legacy expected answer",
      expected_output: "legacy snake-case expected answer",
    },
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
          meta: { at: "2026-01-01T00:00:00.000Z", id: "event-1" },
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
      traceContexts: [],
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
    submitSpan: vi.fn(async (_row: unknown) => span),
    submitEvaluationMetrics: vi.fn(async (_span: unknown, _metrics: unknown) => undefined),
    close: vi.fn(async () => undefined),
  };
  let datasetName = "dataset-1";
  let datasetRecords: Array<{
    id: string;
    inputData: unknown;
    expectedOutput?: unknown;
    metadata?: Readonly<Record<string, unknown>>;
  }> = [];
  const dataset = {
    id: vi.fn(() => "dataset-1"),
    name: vi.fn(() => datasetName),
    version: vi.fn(() => 3),
    records: vi.fn(() => datasetRecords),
    url: vi.fn(() => "https://dd.test/dataset"),
    push: vi.fn(async () => ({
      pushedCount: datasetRecords.length,
      totalCount: datasetRecords.length,
    })),
  };
  const client = {
    createDataset: vi.fn(
      (
        name: string,
        options?: {
          records?: Array<{
            inputData: unknown;
            expectedOutput?: unknown;
            metadata?: Readonly<Record<string, unknown>>;
          }>;
        },
      ) => {
        datasetName = name;
        datasetRecords = (options?.records ?? []).map((record, index) => ({
          id: `record-${index + 1}`,
          ...record,
        }));
        return dataset;
      },
    ),
    startExperiment: vi.fn(async (_options: unknown) => experiment),
  };
  const lines: string[] = [];
  const config = {
    projectName: "test-project",
    client,
    log: (line: string) => lines.push(line),
    ...overrides,
  } satisfies DatadogReporterConfig;

  return { client, config, dataset, experiment, lines, span };
}

describe("Datadog", () => {
  it("creates an experiment, submits one span, and attaches assertion metrics", async () => {
    const { client, config, experiment, span } = makeConfig({ experimentName: "run-1" });
    const reporter = Datadog(config);
    const evaluation = makeEval();
    const result = makeEvalResult();

    await reporter.onRunStart([evaluation], makeTarget());
    await reporter.onEvalComplete(result);

    expect(client.createDataset).not.toHaveBeenCalled();
    expect(client.startExperiment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run-1",
        projectName: "test-project",
        dataset: { name: "run-1 dataset" },
        tags: expect.objectContaining({ source: "eve", target_kind: "local" }),
        metadata: expect.objectContaining({
          eveEvalIds: ["eval-1"],
          eveTargetKind: "local",
          eveTargetOrigin: "http://127.0.0.1:3000",
        }),
      }),
    );
    expect(experiment.submitSpan).toHaveBeenCalledWith(
      expect.objectContaining({
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
    const submittedSpan = experiment.submitSpan.mock.calls[0]?.[0];
    expect(submittedSpan).not.toHaveProperty("id");
    expect(submittedSpan).not.toHaveProperty("input");
    expect(submittedSpan).not.toHaveProperty("output");
    expect(submittedSpan).not.toHaveProperty("expectedOutput");
    expect(submittedSpan).not.toHaveProperty("metadata.expectedOutput");
    expect(submittedSpan).not.toHaveProperty("metadata.expected");
    expect(submittedSpan).not.toHaveProperty("metadata.expected_output");
    expect(experiment.submitEvaluationMetrics).toHaveBeenCalledWith(span, [
      expect.objectContaining({ label: "gate_succeeded", value: 1 }),
      expect.objectContaining({ label: "similarity", value: 0.9 }),
      expect.objectContaining({ label: "judge_autoevals_closedQA", value: 1 }),
      expect.objectContaining({ label: "eve_tool_call_count", value: 1 }),
      expect.objectContaining({ label: "eve_subagent_call_count", value: 0 }),
      expect.objectContaining({ label: "eve_message_count", value: 1 }),
      expect.objectContaining({ label: "eve_reasoning_block_count", value: 0 }),
    ]);
    expect(experiment.submitEvaluationMetrics.mock.calls[0]?.[1]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tags: expect.objectContaining({ assertion_name: expect.anything() }),
        }),
      ]),
    );
  });

  it("redacts target URL secrets and execution errors by default", async () => {
    const { client, config, experiment } = makeConfig();
    const reporter = Datadog(config);
    const target: EveEvalTarget = {
      ...makeTarget("remote"),
      url: "https://user:password@test.vercel.app/agent?token=private#fragment",
    };

    await reporter.onRunStart([makeEval()], target);
    await reporter.onEvalComplete(makeEvalResult({ error: "private application error" }));

    expect(client.startExperiment).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ eveTargetOrigin: "https://test.vercel.app" }),
      }),
    );
    expect(client.startExperiment.mock.calls[0]?.[0]).not.toHaveProperty("metadata.eveTargetUrl");
    expect(experiment.submitSpan.mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("records execution errors only when enabled", async () => {
    const { config, experiment } = makeConfig({ recordErrors: true });
    const reporter = Datadog(config);

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onEvalComplete(makeEvalResult({ error: "application error" }));

    expect(experiment.submitSpan).toHaveBeenCalledWith(
      expect.objectContaining({ error: "application error" }),
    );
  });

  it("redacts failing assertion details by default", async () => {
    const { config, experiment } = makeConfig();
    const reporter = Datadog(config);
    const result = makeEvalResult({
      assertions: [
        {
          name: "messageIncludes(private expectation)",
          message: "got private assistant output",
          score: 0,
          severity: "gate",
          passed: false,
        },
      ],
      verdict: "failed",
    });

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onEvalComplete(result);

    expect(experiment.submitSpan.mock.calls[0]?.[0]).not.toHaveProperty(
      "metadata.eveFailedAssertions",
    );
    expect(experiment.submitEvaluationMetrics.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "gate_messageIncludes_private_expectation",
          tags: {
            assertion_index: "1",
            assertion_severity: "gate",
            assertion_passed: "false",
          },
        }),
      ]),
    );
  });

  it("records assertion name tags and failure messages only when enabled", async () => {
    const { config, experiment } = makeConfig({ recordAssertionDetails: true });
    const reporter = Datadog(config);
    const result = makeEvalResult({
      assertions: [
        {
          name: "messageIncludes(private expectation)",
          message: "got private assistant output",
          score: 0,
          severity: "gate",
          passed: false,
        },
      ],
      verdict: "failed",
    });

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onEvalComplete(result);

    expect(experiment.submitSpan.mock.calls[0]?.[0]).toHaveProperty(
      "metadata.eveFailedAssertions",
      [
        {
          name: "messageIncludes(private expectation)",
          message: "got private assistant output",
        },
      ],
    );
    expect(experiment.submitEvaluationMetrics.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "gate_messageIncludes_private_expectation",
          tags: expect.objectContaining({
            assertion_name: "messageIncludes(private expectation)",
          }),
        }),
      ]),
    );
  });

  it("deduplicates assertion metric labels and reserves built-in labels", async () => {
    const { config, experiment } = makeConfig({ recordAssertionDetails: true });
    const reporter = Datadog(config);
    const result = makeEvalResult({
      assertions: [
        { name: "same label", score: 1, severity: "soft", passed: true },
        { name: "same@label", score: 1, severity: "soft", passed: true },
        { name: "same label", score: 1, severity: "soft", passed: true },
        { name: "eve_tool_call_count", score: 1, severity: "soft", passed: true },
      ],
    });

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onEvalComplete(result);

    expect(experiment.submitEvaluationMetrics.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ label: "same_label" }),
      expect.objectContaining({ label: "same_label_2" }),
      expect.objectContaining({ label: "same_label_3" }),
      expect.objectContaining({ label: "eve_tool_call_count_2" }),
      expect.objectContaining({ label: "eve_tool_call_count" }),
      expect.objectContaining({ label: "eve_subagent_call_count" }),
      expect.objectContaining({ label: "eve_message_count" }),
      expect.objectContaining({ label: "eve_reasoning_block_count" }),
    ]);
  });

  it("creates dataset records from opted-in eval inputs and links experiment rows", async () => {
    const { client, config, dataset, experiment, lines } = makeConfig({
      datasetName: "greeting inputs",
      experimentName: "run-1",
      recordInputs: true,
      recordOutputs: true,
      recordExpectedOutputs: true,
    });
    const reporter = Datadog(config);
    const result = makeEvalResult();

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onEvalComplete(result);

    expect(client.startExperiment).not.toHaveBeenCalled();
    expect(experiment.submitSpan).not.toHaveBeenCalled();

    await reporter.onRunComplete(makeSummary(result));

    expect(client.createDataset).toHaveBeenCalledWith(
      "greeting inputs",
      expect.objectContaining({
        projectName: "test-project",
        records: [
          {
            inputData: "What should I send you?",
            expectedOutput: "helpful onboarding answer",
            metadata: { eveEvalId: "eval-1" },
          },
        ],
      }),
    );
    expect(dataset.push).toHaveBeenCalledOnce();
    expect(dataset.push.mock.invocationCallOrder[0]).toBeLessThan(
      client.startExperiment.mock.invocationCallOrder[0] ?? 0,
    );
    expect(client.startExperiment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run-1",
        dataset: { id: "dataset-1", name: "greeting inputs", version: 3 },
      }),
    );
    expect(experiment.submitSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "What should I send you?",
        output: "actual output",
        expectedOutput: "helpful onboarding answer",
        datasetRecordId: "record-1",
      }),
    );
    expect(lines.join("\n")).toContain("Datadog dataset URL: https://dd.test/dataset");
  });

  it("creates an input-only dataset record when no expected output is authored", async () => {
    const { client, config } = makeConfig({
      datasetName: "input-only dataset",
      recordInputs: true,
      recordExpectedOutputs: true,
    });
    const reporter = Datadog(config);
    const evaluation = makeEval({ metadata: { suite: "unit" } });
    const result = makeEvalResult();

    await reporter.onRunStart([evaluation], makeTarget());
    await reporter.onEvalComplete(result);
    await reporter.onRunComplete(makeSummary(result));

    const record = client.createDataset.mock.calls[0]?.[1]?.records?.[0];
    expect(record).toEqual({
      inputData: "What should I send you?",
      metadata: { eveEvalId: "eval-1" },
    });
  });

  it("uses the dd-trace project environment variable by default", async () => {
    vi.stubEnv("DD_LLMOBS_PROJECT_NAME", "environment-project");
    try {
      const { client, config } = makeConfig({ projectName: undefined });
      const reporter = Datadog(config);

      await reporter.onRunStart([makeEval()], makeTarget());

      expect(client.startExperiment).toHaveBeenCalledWith(
        expect.objectContaining({ projectName: "environment-project" }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
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
