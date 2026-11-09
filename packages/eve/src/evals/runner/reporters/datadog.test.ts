import { describe, expect, it, vi } from "vitest";
import { datadogReporter, type DatadogReporterConfig } from "#evals/reporters/index.js";
import type {
  DatadogDataset,
  DatadogDatasetRecord,
  DatadogExperimentsClient,
  DatadogExternalExperimentSpanInput,
  DatadogStartExperimentOptions,
} from "#evals/runner/reporters/datadog-client.js";
import type { EveEval, EveEvalResult, EveEvalTarget } from "#evals/types.js";

vi.mock("#evals/runner/resolve-git-metadata.js", () => ({
  resolveLocalGitMetadata: () => ({}),
}));

const target: EveEvalTarget = {
  capabilities: { devRoutes: false },
  kind: "remote",
  url: "https://alice:hunter2@agent.example.com/eve?token=secret-token#frag",
};

function makeEval(id: string, description?: string): EveEval {
  return { _tag: "EveEval", id, description, test: async () => {} };
}

function makeResult(id: string): EveEvalResult {
  return {
    id,
    result: {
      sessionEnded: false,
      data: "output",
      reply: "output",
      status: "completed",
      events: [],
      derived: {
        toolCalls: [],
        toolCallCount: 0,
        skillLoads: [],
        subagentCalls: [],
        subagentCallCount: 0,
        interactions: [],
        parked: false,
        messageCount: 1,
        reasoningBlockCount: 0,
        models: [],
      },
      sessionId: `session-${id}`,
      traceContexts: [],
    },
    assertions: [
      {
        name: "mentions blue",
        score: 0,
        severity: "gate",
        passed: false,
        errored: false,
        message: "Reply did not mention blue.",
      },
    ],
    error: "Bob's request timed out.",
    verdict: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
}

/** A pulled dataset that already holds Alice's record from an earlier run. */
function memoryDataset(existing: DatadogDatasetRecord[]) {
  const records = [...existing];
  const added: unknown[] = [];
  const updated: number[] = [];
  const dataset: DatadogDataset = {
    id: () => "dataset-1",
    name: () => "eve evals",
    version: () => null,
    latestVersion: () => 3,
    records: () => records,
    addRecords(inputs) {
      added.push(...inputs);
      for (const input of inputs) {
        records.push({
          id: `record-${records.length + 1}`,
          input: input.inputData,
          expectedOutput: input.expectedOutput ?? null,
          metadata: input.metadata ?? {},
        });
      }
      return dataset;
    },
    update(index) {
      updated.push(index);
      return dataset;
    },
    url: () => null,
    push: async () => ({ pushedCount: added.length, totalCount: records.length }),
  };
  return { added, dataset, updated };
}

function memoryClient(dataset: DatadogDataset) {
  const experiments: DatadogStartExperimentOptions[] = [];
  const spans: DatadogExternalExperimentSpanInput[] = [];
  const client: DatadogExperimentsClient = {
    createDataset: () => dataset,
    pullDataset: async () => dataset,
    async startExperiment(options) {
      experiments.push(options);
      return {
        experimentId: () => "experiment-1",
        url: () => null,
        async submitSpan(row) {
          spans.push(row);
          return { experimentId: "experiment-1", spanId: "span", traceId: "trace", url: null };
        },
        submitEvaluationMetrics: async () => {},
        close: async () => {},
      };
    },
  };
  return { client, experiments, spans };
}

async function report(
  config: Partial<DatadogReporterConfig>,
  evaluations: readonly EveEval[],
  existing: DatadogDatasetRecord[] = [],
) {
  const memory = memoryDataset(existing);
  const recorded = memoryClient(memory.dataset);
  const reporter = datadogReporter({ client: recorded.client, log: () => {}, ...config });
  const results = evaluations.map((evaluation) => makeResult(evaluation.id));
  await reporter.onRunStart?.(evaluations, target);
  for (const result of results) await reporter.onEvalComplete?.(result);
  await reporter.onRunComplete?.({
    target,
    results,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    passed: 0,
    failed: results.length,
    scored: 0,
    skipped: 0,
    errored: 0,
  });
  return { ...memory, ...recorded };
}

describe("datadogReporter", () => {
  it("records only the target origin, without credentials, path, or query", async () => {
    const { experiments } = await report({ recordInputs: false }, [makeEval("eval-1")]);

    expect(experiments[0]?.metadata?.eveTargetOrigin).toBe("https://agent.example.com");
    expect(JSON.stringify(experiments)).not.toMatch(/hunter2|secret-token|alice/);
  });

  it("omits errors and assertion details when their recording is turned off", async () => {
    const { spans } = await report(
      { recordAssertionDetails: false, recordErrors: false, recordInputs: false },
      [makeEval("eval-1")],
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]).not.toHaveProperty("error");
    expect(spans[0]?.metadata).not.toHaveProperty("eveFailedAssertions");
    expect(spans[0]?.metadata).not.toHaveProperty("eveAssertionScores");
  });

  it("reuses an unchanged dataset record and keys repeated descriptions apart", async () => {
    const evaluations = [
      makeEval("eval-1", "Alice picks a color"),
      makeEval("eval-2", "Bob asks twice"),
      makeEval("eval-3", "Bob asks twice"),
    ];
    const { added, spans, updated } = await report({}, evaluations, [
      {
        id: "record-alice",
        input: "Alice picks a color",
        expectedOutput: null,
        metadata: { eveRecordKey: "Alice picks a color", eveEvalId: "eval-1" },
      },
    ]);

    expect(updated).toEqual([]);
    expect(added).toEqual([
      expect.objectContaining({
        metadata: { eveRecordKey: "Bob asks twice", eveEvalId: "eval-2" },
      }),
      expect.objectContaining({
        metadata: { eveRecordKey: "Bob asks twice #2", eveEvalId: "eval-3" },
      }),
    ]);
    expect(spans.map((span) => span.datasetRecordId)).toEqual([
      "record-alice",
      "record-2",
      "record-3",
    ]);
  });

  it("shares one dataset record across repeated attempts and tags each span's iteration", async () => {
    const memory = memoryDataset([]);
    const { client, spans } = memoryClient(memory.dataset);
    const reporter = datadogReporter({ client, log: () => {} });
    const results = [1, 2, 3].map((attempt) => ({ ...makeResult("eval-1"), attempt }));
    await reporter.onRunStart?.([makeEval("eval-1", "Alice picks a color")], target);
    await reporter.onRunComplete?.({
      target,
      results,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      passed: 0,
      failed: results.length,
      scored: 0,
      skipped: 0,
      errored: 0,
    });

    expect(memory.added).toHaveLength(1);
    expect(
      spans.map((span) => ({
        datasetRecordId: span.datasetRecordId,
        runIteration: span.runIteration,
      })),
    ).toEqual([1, 2, 3].map((runIteration) => ({ datasetRecordId: "record-1", runIteration })));
  });
});
