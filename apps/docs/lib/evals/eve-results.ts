import rawSnapshot from "./eve-benchmark.json";

export interface EveToolUsage {
  name: string;
  count: number;
}

export interface EveHarnessOverhead {
  firstStepInputTokens: number | null;
  modelStepsMedian: number | null;
  modelStepsTotal: number | null;
  toolCallsMedian: number | null;
  toolCallsTotal: number | null;
  topTools: EveToolUsage[];
}

export interface EveEffectSummary {
  better: number;
  worse: number;
  estimate: number | null;
  low: number | null;
  high: number | null;
  verdict: "better" | "worse" | "inconclusive";
}

/** Written by `.github/scripts/eve-docs-snapshot.mjs` from eve-bench reports of `main`. */
export interface EveHarnessScore {
  harness: string;
  /** Package version for released harnesses; short source commit for eve. */
  version: string | null;
  resolved: number;
  attempts: number;
  resolveRate: { estimate: number; low: number; high: number };
  passAllTasks: number | null;
  passAllRate: number | null;
  costUsd: number | null;
  medianCostUsd: number | null;
  costPerResolvedUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedShare: number | null;
  latencyP50Ms: number;
  latencyP90Ms: number;
  overhead: EveHarnessOverhead | null;
  effectsVsEve: Record<string, EveEffectSummary> | null;
  source: string | null;
  runUrl: string | null;
  measuredAt: string | null;
}

export interface EveTaskCell {
  resolved: number;
  attempts: number;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface EveTaskRow {
  task: string;
  cells: Record<string, EveTaskCell>;
}

export interface EveModelResults {
  family: string;
  model: { id: string; released?: string; knowledge?: string };
  generatedAt: string;
  runUrl: string | null;
  harnesses: EveHarnessScore[];
  taskMatrix: EveTaskRow[];
}

export interface EveDatasetResults {
  dataset: { name: string; version: string; commit?: string };
  attempts: number;
  tasks: number;
  reasoning: string | null;
  models: Record<string, EveModelResults>;
}

export interface EveBenchmarkSnapshot {
  schemaVersion: 2;
  datasets: Record<string, EveDatasetResults>;
}

export const eveBenchmark = rawSnapshot as EveBenchmarkSnapshot;

const FAMILY_ORDER = ["openai", "anthropic"];

export function orderedModels(results: EveDatasetResults): EveModelResults[] {
  return Object.values(results.models).sort((left, right) => {
    const leftIndex = FAMILY_ORDER.indexOf(left.family);
    const rightIndex = FAMILY_ORDER.indexOf(right.family);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }
    return left.family.localeCompare(right.family);
  });
}

export { rankedHarnesses } from "./eve-format";
