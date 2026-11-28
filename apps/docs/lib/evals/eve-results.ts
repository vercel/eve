import rawSnapshot from "./eve-benchmark.json";

export interface EveToolUsage {
  name: string;
  count: number;
}

export interface EveHarnessOverhead {
  firstStepInputTokens: number | null;
  modelStepsMedian: number | null;
  toolCallsMedian: number | null;
  topTools: EveToolUsage[];
}

export interface EveEffectSummary {
  better: number;
  worse: number;
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
}

export interface EveTaskRow {
  task: string;
  cells: Record<string, EveTaskCell>;
}

export interface EveModelResults {
  dataset: { name: string; version: string; commit?: string };
  family: string;
  model: { id: string; released?: string; knowledge?: string };
  attempts: number;
  tasks: number;
  reasoning: string | null;
  generatedAt: string;
  runUrl: string | null;
  harnesses: EveHarnessScore[];
  taskMatrix: EveTaskRow[];
}

export interface EveDatasetResults {
  models: Record<string, EveModelResults>;
}

export interface EveBenchmarkSnapshot {
  schemaVersion: 2;
  datasets: Record<string, EveDatasetResults>;
}

export const eveBenchmark = rawSnapshot as EveBenchmarkSnapshot;

export { isReferenceHarness, orderedModels, rankedHarnesses } from "./eve-format";
