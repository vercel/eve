import { describe, expect, it } from "vitest";
import { benchmarkRows, type PublishedBenchmarkResults } from "./results";

const experiments = [
  {
    id: "agent--baseline",
    groupId: "agent",
    model: "model",
    modelDisplayName: "Model",
    harness: "Harness",
    treatment: "baseline" as const,
  },
  {
    id: "agent--guided",
    groupId: "agent",
    model: "model",
    modelDisplayName: "Model",
    harness: "Harness",
    treatment: "guided" as const,
  },
];

const base: PublishedBenchmarkResults = {
  schemaVersion: 1,
  generatedAt: "2026-08-13T00:00:00.000Z",
  suite: {
    eveRevision: "a".repeat(40),
    caseFingerprint: "b".repeat(64),
    caseCount: 2,
    runsPerCell: 3,
  },
  experiments,
  results: [],
};

describe("benchmarkRows", () => {
  it("aggregates successful valid runs and weights duration by run count", () => {
    const rows = benchmarkRows({
      ...base,
      results: [
        {
          experimentId: "agent--baseline",
          caseId: "one",
          status: "current",
          passedRuns: 1,
          validRuns: 3,
          meanDurationMs: 1000,
          meanEstimatedListCostUsd: 0.1,
          meanTokenConsumption: 100,
          meanToolInvocationCount: 10,
        },
        {
          experimentId: "agent--guided",
          caseId: "one",
          status: "current",
          passedRuns: 3,
          validRuns: 3,
          meanDurationMs: 3000,
          meanEstimatedListCostUsd: 0.3,
          meanTokenConsumption: 300,
          meanToolInvocationCount: 30,
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      groupId: "agent",
      modelDisplayName: "Model",
      harness: "Harness",
      averageDurationMs: 2000,
      averageEstimatedListCostUsd: 0.2,
      guidedSuccessRate: 50,
    });
    expect(rows[0]?.baselineSuccessRate).toBeCloseTo(100 / 6);
    expect(rows[0]?.cases).toHaveLength(1);
    expect(rows[0]?.cases[0]).toMatchObject({
      caseId: "one",
      averageDurationMs: 2000,
      averageTokenConsumption: 200,
      averageToolInvocationCount: 20,
      guidedSuccessRate: 100,
    });
    expect(rows[0]?.cases[0]?.baselineSuccessRate).toBeCloseTo(100 / 3);
  });

  it("sorts by baseline success, guided success, then recency", () => {
    const sortingExperiments = ["older", "newer", "higher"].flatMap((groupId) =>
      (["baseline", "guided"] as const).map((treatment) => ({
        id: `${groupId}--${treatment}`,
        groupId,
        model: groupId,
        modelDisplayName: groupId,
        harness: "Harness",
        treatment,
      })),
    );
    const result = (
      experimentId: string,
      passedRuns: number,
      measuredAt: string,
    ): PublishedBenchmarkResults["results"][number] => ({
      experimentId,
      caseId: "one",
      status: "current",
      passedRuns,
      validRuns: 3,
      meanDurationMs: 1000,
      measuredAt,
    });

    const rows = benchmarkRows({
      ...base,
      suite: { ...base.suite, caseCount: 1 },
      experiments: sortingExperiments,
      results: [
        result("older--baseline", 2, "2026-08-01T00:00:00.000Z"),
        result("older--guided", 3, "2026-08-01T00:00:00.000Z"),
        result("newer--baseline", 2, "2026-08-02T00:00:00.000Z"),
        result("newer--guided", 3, "2026-08-02T00:00:00.000Z"),
        result("higher--baseline", 3, "2026-08-01T00:00:00.000Z"),
        result("higher--guided", 0, "2026-08-01T00:00:00.000Z"),
      ],
    });

    expect(rows.map((row) => row.groupId)).toEqual(["higher", "newer", "older"]);
  });

  it("counts missing cells against aggregate success rates", () => {
    const [row] = benchmarkRows({
      ...base,
      results: [
        { experimentId: "agent--baseline", caseId: "one", status: "stale" },
        { experimentId: "agent--guided", caseId: "one", status: "missing" },
      ],
    });

    expect(row).toMatchObject({
      averageDurationMs: null,
      baselineSuccessRate: 0,
      guidedSuccessRate: 0,
    });
  });

  it("keeps stale measurements until the model reruns the case", () => {
    const [row] = benchmarkRows({
      ...base,
      results: [
        {
          experimentId: "agent--baseline",
          caseId: "one",
          status: "stale",
          passedRuns: 2,
          validRuns: 3,
          meanDurationMs: 1000,
        },
      ],
    });

    expect(row).toMatchObject({
      averageDurationMs: 1000,
      guidedSuccessRate: 0,
    });
    expect(row?.baselineSuccessRate).toBeCloseTo(100 / 3);
    expect(row?.cases[0]?.baselineSuccessRate).toBeCloseTo(200 / 3);
  });
});
