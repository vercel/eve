import rawSnapshot from "./eve-code-benchmark.json";

/** Written by `.github/scripts/eve-code-docs-snapshot.mjs` from eve-bench reports of `main`. */
export interface EveCodeHarnessScore {
  harness: string;
  /** Package version for released harnesses; short source commit for eve-code. */
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

export interface EveCodeDatasetResults {
  dataset: { name: string; version: string };
  model: { id: string; released?: string; knowledge?: string };
  attempts: number;
  tasks: number;
  generatedAt: string;
  harnesses: EveCodeHarnessScore[];
}

export interface EveCodeBenchmarkSnapshot {
  schemaVersion: 1;
  datasets: Record<string, EveCodeDatasetResults>;
}

export const eveCodeBenchmark = rawSnapshot as EveCodeBenchmarkSnapshot;

/** Ranks by resolve rate, then by median latency, matching eve-bench's correctness-first order. */
export function rankedHarnesses(results: EveCodeDatasetResults): EveCodeHarnessScore[] {
  return [...results.harnesses].sort(
    (left, right) =>
      right.resolveRate.estimate - left.resolveRate.estimate ||
      left.latencyP50Ms - right.latencyP50Ms,
  );
}
