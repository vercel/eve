import rawResults from "./benchmark-results.json";

export type BenchmarkTreatment = "baseline" | "guided";
export type BenchmarkCellStatus = "current" | "missing" | "stale";

export interface BenchmarkExperiment {
  id: string;
  groupId: string;
  model: string;
  modelDisplayName: string;
  harness: string;
  treatment: BenchmarkTreatment;
}

export interface BenchmarkResult {
  experimentId: string;
  caseId: string;
  status: BenchmarkCellStatus;
  passedRuns?: number;
  validRuns?: number;
  meanDurationMs?: number;
  meanEstimatedListCostUsd?: number;
  meanTokenConsumption?: number;
  meanToolInvocationCount?: number;
  measuredAt?: string;
}

export interface BenchmarkSuite {
  eveRevision: string | null;
  caseFingerprint: string | null;
  caseCount: number;
  runsPerCell: number;
}

export interface PreviouslyMeasuredBenchmarkResults {
  suite: BenchmarkSuite;
  experiments: BenchmarkExperiment[];
  results: BenchmarkResult[];
}

export interface PublishedBenchmarkResults {
  schemaVersion: 1;
  generatedAt: string | null;
  suite: BenchmarkSuite;
  experiments: BenchmarkExperiment[];
  results: BenchmarkResult[];
  previouslyMeasured?: PreviouslyMeasuredBenchmarkResults[];
}

export interface BenchmarkCaseRow {
  caseId: string;
  averageDurationMs: number | null;
  averageTokenConsumption: number | null;
  averageToolInvocationCount: number | null;
  baselineSuccessRate: number | null;
  guidedSuccessRate: number | null;
}

export interface BenchmarkRow {
  groupId: string;
  modelDisplayName: string;
  harness: string;
  averageDurationMs: number | null;
  averageEstimatedListCostUsd: number | null;
  baselineSuccessRate: number | null;
  guidedSuccessRate: number | null;
  latestMeasuredAt: string | null;
  cases: BenchmarkCaseRow[];
}

export const benchmarkResults = rawResults as PublishedBenchmarkResults;

export function benchmarkRows(data: PublishedBenchmarkResults): BenchmarkRow[] {
  const groups = Map.groupBy(data.experiments, (experiment) => experiment.groupId);
  const rows = [...groups.entries()].map(([groupId, experiments]) => {
    const baseline = experiments.find((experiment) => experiment.treatment === "baseline");
    const guided = experiments.find((experiment) => experiment.treatment === "guided");
    const groupResults = data.results.filter(
      (result) => baseline?.id === result.experimentId || guided?.id === result.experimentId,
    );
    const measuredResults = groupResults.filter(isMeasuredResult);
    const expectedRuns = data.suite.caseCount * data.suite.runsPerCell;
    const baselineSuccessRate = baseline
      ? successRate(measuredResults, baseline.id, expectedRuns)
      : null;
    const guidedSuccessRate = guided ? successRate(measuredResults, guided.id, expectedRuns) : null;
    const averageDurationMs = weightedAverageDuration(measuredResults);
    const averageEstimatedListCostUsd = averageEstimatedListCost(measuredResults);
    const experiment = baseline ?? guided;
    if (!experiment) throw new Error(`Benchmark group ${groupId} has no experiments.`);

    const caseIds = [...new Set(groupResults.map((result) => result.caseId))].sort();
    return {
      groupId,
      modelDisplayName: experiment.modelDisplayName,
      harness: experiment.harness,
      averageDurationMs,
      averageEstimatedListCostUsd,
      baselineSuccessRate,
      guidedSuccessRate,
      latestMeasuredAt:
        measuredResults
          .flatMap((result) => (result.measuredAt === undefined ? [] : [result.measuredAt]))
          .sort()
          .at(-1) ?? null,
      cases: caseIds.map((caseId) => {
        const caseResults = measuredResults.filter((result) => result.caseId === caseId);
        const baselineCaseResults = baseline
          ? caseResults.filter((result) => result.experimentId === baseline.id)
          : [];
        const guidedCaseResults = guided
          ? caseResults.filter((result) => result.experimentId === guided.id)
          : [];
        return {
          caseId,
          averageDurationMs: weightedAverageDuration(caseResults),
          averageTokenConsumption: weightedAverageMetric(caseResults, "meanTokenConsumption"),
          averageToolInvocationCount: weightedAverageMetric(caseResults, "meanToolInvocationCount"),
          baselineSuccessRate:
            baselineCaseResults.length === 0
              ? null
              : successRate(baselineCaseResults, baseline!.id, data.suite.runsPerCell),
          guidedSuccessRate:
            guidedCaseResults.length === 0
              ? null
              : successRate(guidedCaseResults, guided!.id, data.suite.runsPerCell),
        };
      }),
    };
  });
  return rows.sort(
    (left, right) =>
      descending(right.baselineSuccessRate, left.baselineSuccessRate) ||
      descending(right.guidedSuccessRate, left.guidedSuccessRate) ||
      timestamp(right.latestMeasuredAt) - timestamp(left.latestMeasuredAt),
  );
}

function isMeasuredResult(result: BenchmarkResult): result is BenchmarkResult & {
  validRuns: number;
  meanDurationMs: number;
} {
  return (
    result.status !== "missing" &&
    result.validRuns !== undefined &&
    result.meanDurationMs !== undefined
  );
}

function successRate(
  results: ReadonlyArray<BenchmarkResult>,
  experimentId: string,
  expectedRuns: number,
): number | null {
  if (expectedRuns === 0) return null;
  const passedRuns = results
    .filter((result) => result.experimentId === experimentId)
    .reduce((total, result) => total + (result.passedRuns ?? 0), 0);
  return (passedRuns / expectedRuns) * 100;
}

function averageEstimatedListCost(results: BenchmarkResult[]): number | null {
  const costs = results.flatMap((result) =>
    result.meanEstimatedListCostUsd === undefined ? [] : [result.meanEstimatedListCostUsd],
  );
  if (costs.length === 0) return null;
  return costs.reduce((total, cost) => total + cost, 0) / costs.length;
}

function weightedAverageDuration(results: BenchmarkResult[]): number | null {
  return weightedAverageMetric(results, "meanDurationMs");
}

function weightedAverageMetric(
  results: BenchmarkResult[],
  field: "meanDurationMs" | "meanTokenConsumption" | "meanToolInvocationCount",
): number | null {
  const measured = results.filter(
    (result): result is BenchmarkResult & { validRuns: number } & Record<typeof field, number> =>
      result.validRuns !== undefined && result[field] !== undefined,
  );
  const validRuns = measured.reduce((total, result) => total + result.validRuns, 0);
  if (validRuns === 0) return null;
  return (
    measured.reduce((total, result) => total + result[field] * result.validRuns, 0) / validRuns
  );
}

function descending(higher: number | null, lower: number | null): number {
  return (higher ?? Number.NEGATIVE_INFINITY) - (lower ?? Number.NEGATIVE_INFINITY);
}

function timestamp(value: string | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : Date.parse(value);
}
