import rawSnapshot from "./eve-benchmark.json";

/** Written by `.github/scripts/eve-docs-snapshot.mjs` from eve-bench reports of `main`. */
export interface EveHarnessScore {
  harness: string;
  /** Package version for released harnesses; short source commit for eve. */
  version: string | null;
  resolved: number;
  attempts: number;
  resolveRate: { estimate: number; low: number; high: number };
  costUsd: number | null;
  costPerResolvedUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedShare: number | null;
  latencyP50Ms: number;
  latencyP90Ms: number;
  source: string | null;
  runUrl: string | null;
  measuredAt: string | null;
}

export interface EveDatasetResults {
  dataset: { name: string; version: string };
  model: { id: string; released?: string; knowledge?: string };
  attempts: number;
  tasks: number;
  generatedAt: string;
  harnesses: EveHarnessScore[];
}

export interface EveBenchmarkSnapshot {
  schemaVersion: 1;
  datasets: Record<string, EveDatasetResults>;
}

export const eveBenchmark = rawSnapshot as EveBenchmarkSnapshot;

export { rankedHarnesses } from "./eve-format";
