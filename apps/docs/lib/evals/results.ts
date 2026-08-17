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
  measuredAt?: string;
}

export interface PublishedBenchmarkResults {
  schemaVersion: 1;
  generatedAt: string | null;
  suite: {
    eveRevision: string | null;
    caseFingerprint: string | null;
    caseCount: number;
    runsPerCell: number;
  };
  experiments: BenchmarkExperiment[];
  results: BenchmarkResult[];
}

export interface BenchmarkCaseRow {
  caseId: string;
  averageDurationMs: number | null;
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
  cases: BenchmarkCaseRow[];
}

export const benchmarkResults = rawResults as PublishedBenchmarkResults;

export function benchmarkRows(data: PublishedBenchmarkResults): BenchmarkRow[] {
  const groups = Map.groupBy(data.experiments, (experiment) => experiment.groupId);
  return [...groups.entries()].map(([groupId, experiments]) => {
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
  const validRuns = results.reduce((total, result) => total + (result.validRuns ?? 0), 0);
  if (validRuns === 0) return null;
  const duration = results.reduce(
    (total, result) => total + (result.meanDurationMs ?? 0) * (result.validRuns ?? 0),
    0,
  );
  return duration / validRuns;
}
