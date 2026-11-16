interface ComparableTask {
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly id: string;
  readonly success: boolean | null;
}

export function compareBenchmarkTasks(
  baseline: ComparableTask | undefined,
  candidate: ComparableTask | undefined
) {
  if (baseline?.success !== true || candidate?.success !== true) {
    return { cost: null, time: null };
  }
  return {
    cost: improvementRatio(baseline.costUsd, candidate.costUsd),
    time: improvementRatio(baseline.durationMs, candidate.durationMs),
  };
}

export function averageBenchmarkImprovement(
  baseline: readonly ComparableTask[],
  candidate: readonly ComparableTask[]
) {
  const comparisons = baseline.flatMap((baselineTask) => {
    const candidateTask = candidate.find((task) => task.id === baselineTask.id);
    return candidateTask
      ? [compareBenchmarkTasks(baselineTask, candidateTask)]
      : [];
  });
  return {
    cost: mean(comparisons.flatMap((value) => finite(value.cost))),
    time: mean(comparisons.flatMap((value) => finite(value.time))),
  };
}

function improvementRatio(
  baseline: number | null | undefined,
  candidate: number | null | undefined
) {
  if (
    baseline === null ||
    baseline === undefined ||
    candidate === null ||
    candidate === undefined ||
    baseline <= 0
  ) {
    return null;
  }
  return (candidate - baseline) / baseline;
}

function finite(value: number | null) {
  return value !== null && Number.isFinite(value) ? [value] : [];
}

function mean(values: readonly number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
