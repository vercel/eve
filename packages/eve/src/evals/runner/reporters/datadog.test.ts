import { describe, expect, it, vi } from "vitest";

import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { Datadog, type DatadogReporterConfig } from "#evals/reporters/index.js";
import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";

const RECORDING_DISABLED = {
  recordInputs: false,
  recordOutputs: false,
  recordExpectedOutputs: false,
  recordAssertionDetails: false,
  recordErrors: false,
} satisfies DatadogReporterConfig;

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
      { name: "succeeded", score: 1, severity: "gate", passed: true, errored: false },
      {
        name: "similarity",
        score: 0.9,
        severity: "soft",
        threshold: 0.6,
        passed: true,
        errored: false,
      },
      { name: "judge.boolean", score: 1, severity: "soft", passed: true, errored: false },
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

type FakeJson = string | number | boolean | null | FakeJson[] | { [key: string]: FakeJson };

interface FakeDatasetRecord {
  id: string;
  input: FakeJson;
  expectedOutput: FakeJson;
  metadata: Record<string, FakeJson>;
}

/** In-memory stand-in for Datadog datasets that persists across reporter runs. */
function makeDatasetStore() {
  const stored = new Map<string, { id: string; version: number; records: FakeDatasetRecord[] }>();
  let nextRecordId = 1;

  // Like dd-trace, version() stays null until a push creates a new version.
  function open(name: string, initialRecords: readonly FakeDatasetRecord[]) {
    let records = initialRecords.map((record) => ({ ...record }));
    let version: number | null = null;
    let hasChanges = false;
    const dataset = {
      id: () => stored.get(name)?.id ?? null,
      name: () => name,
      version: () => version,
      latestVersion: () => stored.get(name)?.version ?? null,
      records: () => records,
      url: () => `https://dd.test/datasets/${name}`,
      addRecords: vi.fn(
        (
          added: Array<{
            inputData: FakeJson;
            expectedOutput?: FakeJson;
            metadata?: Record<string, FakeJson>;
          }>,
        ) => {
          for (const record of added) {
            records.push({
              id: `record-${nextRecordId++}`,
              input: record.inputData,
              expectedOutput: record.expectedOutput ?? null,
              metadata: record.metadata ?? {},
            });
          }
          hasChanges = true;
          return dataset;
        },
      ),
      update: vi.fn((index: number, fields: Partial<Omit<FakeDatasetRecord, "id">>) => {
        records = records.map((record, recordIndex) =>
          recordIndex === index ? { ...record, ...fields } : record,
        );
        hasChanges = true;
        return dataset;
      }),
      push: vi.fn(async () => {
        const current = stored.get(name);
        if (!hasChanges && current) return { pushedCount: 0, totalCount: 0 };
        const nextVersion = (current?.version ?? 0) + 1;
        stored.set(name, {
          id: current?.id ?? `dataset-${stored.size + 1}`,
          version: nextVersion,
          records: records.map((record) => ({ ...record })),
        });
        version = nextVersion;
        hasChanges = false;
        return { pushedCount: records.length, totalCount: records.length };
      }),
    };
    return dataset;
  }

  return {
    create: (name: string) => open(name, []),
    async pull(name: string) {
      const remote = stored.get(name);
      if (!remote)
        throw new Error(`Dataset '${name}' not found in project 'test-project' (after 5000ms)`);
      return open(name, remote.records);
    },
    get: (name: string) => stored.get(name),
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
  const datasets = makeDatasetStore();
  const client = {
    createDataset: vi.fn(
      (name: string, _options?: { projectName?: string; description?: string }) =>
        datasets.create(name),
    ),
    pullDataset: vi.fn(
      async (name: string, _options?: { projectName?: string; maxWaitMs?: number }) =>
        datasets.pull(name),
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

  return { client, config, datasets, experiment, lines, span };
}

describe("Datadog", () => {
  it("submits scores only, as evals finish, when every recording option is disabled", async () => {
    const { client, config, experiment, span } = makeConfig({
      experimentName: "run-1",
      ...RECORDING_DISABLED,
    });
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
      expect.objectContaining({ label: "judge_boolean", value: 1 }),
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

  it("redacts target URL secrets and omits execution errors when recordErrors is disabled", async () => {
    const { client, config, experiment } = makeConfig({ recordInputs: false, recordErrors: false });
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

  it("records execution errors by default", async () => {
    const { config, experiment } = makeConfig();
    const reporter = Datadog(config);

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onRunComplete(makeSummary(makeEvalResult({ error: "application error" })));

    expect(experiment.submitSpan).toHaveBeenCalledWith(
      expect.objectContaining({ error: "application error" }),
    );
  });

  it("redacts failing assertion details when recordAssertionDetails is disabled", async () => {
    const { config, experiment } = makeConfig({
      recordInputs: false,
      recordAssertionDetails: false,
    });
    const reporter = Datadog(config);
    const result = makeEvalResult({
      assertions: [
        {
          name: "messageIncludes(private expectation)",
          message: "got private assistant output",
          score: 0,
          severity: "gate",
          passed: false,
          errored: false,
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

  it("records assertion name tags and failure messages by default", async () => {
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
          errored: false,
        },
      ],
      verdict: "failed",
    });

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onRunComplete(makeSummary(result));

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
    const { config, experiment } = makeConfig({ recordInputs: false });
    const reporter = Datadog(config);
    const result = makeEvalResult({
      assertions: [
        { name: "same label", score: 1, severity: "soft", passed: true, errored: false },
        { name: "same@label", score: 1, severity: "soft", passed: true, errored: false },
        { name: "same label", score: 1, severity: "soft", passed: true, errored: false },
        { name: "eve_tool_call_count", score: 1, severity: "soft", passed: true, errored: false },
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

  it("records inputs, outputs, and expected outputs in a shared dataset by default", async () => {
    const { client, config, datasets, experiment, lines } = makeConfig({ experimentName: "run-1" });
    const reporter = Datadog(config);
    const result = makeEvalResult();

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onEvalComplete(result);

    expect(client.startExperiment).not.toHaveBeenCalled();
    expect(experiment.submitSpan).not.toHaveBeenCalled();

    await reporter.onRunComplete(makeSummary(result));

    expect(client.pullDataset).toHaveBeenCalledWith(
      "test-project evals",
      expect.objectContaining({ projectName: "test-project" }),
    );
    expect(client.createDataset).toHaveBeenCalledWith(
      "test-project evals",
      expect.objectContaining({ projectName: "test-project" }),
    );
    expect(datasets.get("test-project evals")?.records).toEqual([
      {
        id: "record-1",
        input: "What should I send you?",
        expectedOutput: "helpful onboarding answer",
        metadata: { eveRecordKey: "Say hello", eveEvalId: "eval-1" },
      },
    ]);
    expect(client.startExperiment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run-1",
        dataset: { id: "dataset-1", name: "test-project evals", version: 1 },
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
    expect(lines.join("\n")).toContain(
      "Datadog dataset URL: https://dd.test/datasets/test-project evals",
    );
  });

  it("reuses dataset records by description across runs even when eval ids shift", async () => {
    const { client, config, datasets, experiment } = makeConfig();
    const reporter = Datadog(config);
    const first = makeEval({ id: "cases/0000", description: "First case" });
    const second = makeEval({ id: "cases/0001", description: "Second case" });

    await reporter.onRunStart([first, second], makeTarget());
    const firstRun = [makeEvalResult({ id: "cases/0000" }), makeEvalResult({ id: "cases/0001" })];
    await reporter.onRunComplete({ ...makeSummary(), results: firstRun });
    const recordIds = datasets.get("test-project evals")?.records.map((record) => record.id);

    // Removing the first case shifts the second case's index-based id.
    const shifted = makeEval({ id: "cases/0000", description: "Second case" });
    await reporter.onRunStart([shifted], makeTarget());
    await reporter.onRunComplete({
      ...makeSummary(),
      results: [makeEvalResult({ id: "cases/0000" })],
    });

    expect(client.createDataset).toHaveBeenCalledOnce();
    expect(client.startExperiment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dataset: { id: "dataset-1", name: "test-project evals", version: 2 },
      }),
    );
    expect(experiment.submitSpan).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "cases/0000", datasetRecordId: recordIds?.[1] }),
    );
    // Records missing from a run are kept so filtered runs never delete cases.
    expect(datasets.get("test-project evals")?.records).toEqual([
      expect.objectContaining({
        id: recordIds?.[0],
        metadata: expect.objectContaining({ eveRecordKey: "First case" }),
      }),
      expect.objectContaining({
        id: recordIds?.[1],
        metadata: { eveRecordKey: "Second case", eveEvalId: "cases/0000" },
      }),
    ]);
  });

  it("pins the latest version without pushing when records are unchanged", async () => {
    const { client, config } = makeConfig();
    const reporter = Datadog(config);
    const result = makeEvalResult();

    for (let run = 0; run < 2; run += 1) {
      await reporter.onRunStart([makeEval()], makeTarget());
      await reporter.onRunComplete(makeSummary(result));
    }

    expect(client.startExperiment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dataset: { id: "dataset-1", name: "test-project evals", version: 1 },
      }),
    );
  });

  it("updates a record in place when its input changes", async () => {
    const { config, datasets } = makeConfig();
    const reporter = Datadog(config);

    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onRunComplete(makeSummary());
    const recordId = datasets.get("test-project evals")?.records[0]?.id;

    const reworded = makeEvalResult({
      result: {
        ...makeEvalResult().result,
        events: [
          {
            type: "message.received",
            data: { message: "What greeting should I send?", sequence: 1, turnId: "turn-1" },
            meta: { at: "2026-01-01T00:00:00.000Z", id: "event-1" },
          },
        ],
      },
    });
    await reporter.onRunStart([makeEval()], makeTarget());
    await reporter.onRunComplete(makeSummary(reworded));

    expect(datasets.get("test-project evals")).toMatchObject({
      version: 2,
      records: [{ id: recordId, input: "What greeting should I send?" }],
    });
  });

  it("suffixes duplicate descriptions in discovery order and falls back to eval ids", async () => {
    const { config, datasets } = makeConfig();
    const reporter = Datadog(config);
    const evaluations = [
      makeEval({ id: "cases/0000", description: "Same case" }),
      makeEval({ id: "cases/0001", description: "Same case" }),
      makeEval({ id: "cases/0002", description: undefined }),
    ];

    await reporter.onRunStart(evaluations, makeTarget());
    // Completion order differs from discovery order under concurrency.
    await reporter.onRunComplete({
      ...makeSummary(),
      results: [
        makeEvalResult({ id: "cases/0002" }),
        makeEvalResult({ id: "cases/0001" }),
        makeEvalResult({ id: "cases/0000" }),
      ],
    });

    expect(
      datasets.get("test-project evals")?.records.map((record) => record.metadata.eveRecordKey),
    ).toEqual(["cases/0002", "Same case #2", "Same case"]);
  });

  it("creates an input-only dataset record when no expected output is authored", async () => {
    const { config, datasets } = makeConfig({
      datasetName: "input-only dataset",
    });
    const reporter = Datadog(config);
    const evaluation = makeEval({ metadata: { suite: "unit" } });
    const result = makeEvalResult();

    await reporter.onRunStart([evaluation], makeTarget());
    await reporter.onEvalComplete(result);
    await reporter.onRunComplete(makeSummary(result));

    expect(datasets.get("input-only dataset")?.records).toEqual([
      {
        id: "record-1",
        input: "What should I send you?",
        expectedOutput: null,
        metadata: { eveRecordKey: "Say hello", eveEvalId: "eval-1" },
      },
    ]);
  });

  it("does not create a duplicate dataset when pulling fails for another reason", async () => {
    const { client, config } = makeConfig();
    client.pullDataset.mockRejectedValueOnce(
      new Error("Failed to list datasets in project 'test-project': 503"),
    );
    const reporter = Datadog(config);

    await reporter.onRunStart([makeEval()], makeTarget());

    await expect(reporter.onRunComplete(makeSummary())).rejects.toThrow("Failed to list datasets");
    expect(client.createDataset).not.toHaveBeenCalled();
  });

  it("uses the dd-trace project environment variable by default", async () => {
    vi.stubEnv("DD_LLMOBS_PROJECT_NAME", "environment-project");
    try {
      const { client, config } = makeConfig({ projectName: undefined, recordInputs: false });
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

  it("skips reporting without Datadog credentials instead of failing the run", async () => {
    vi.stubEnv("DD_API_KEY", "");
    vi.stubEnv("DD_APP_KEY", "");
    try {
      const lines: string[] = [];
      const reporter = Datadog({ projectName: "test-project", log: (line) => lines.push(line) });

      await reporter.onRunStart([makeEval()], makeTarget());
      await reporter.onEvalComplete(makeEvalResult());
      await reporter.onRunComplete(makeSummary());

      expect(lines).toEqual([
        "Datadog reporting skipped: set DD_API_KEY and DD_APP_KEY to upload eval results.\n",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is a no-op before the experiment is initialized", async () => {
    const reporter = Datadog(makeConfig().config);

    await reporter.onEvalComplete(makeEvalResult());
    await reporter.onRunComplete(makeSummary());
  });
});
