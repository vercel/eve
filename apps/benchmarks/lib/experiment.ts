import type { ExperimentConfig } from "@vercel/agent-eval";

import {
  harnessId,
  type AuthoringBenchmarkModel,
  type AuthoringTreatment,
  publishedBenchmark,
} from "./benchmark-config.js";
import { createNativeAuthoringSetup } from "./native-authoring-setup.js";

export function authoringExperiment(options: {
  readonly revision: string;
  readonly packageSpec: string;
  readonly runs?: number;
  readonly evals?: readonly string[];
  readonly benchmark: AuthoringBenchmarkModel;
  readonly treatment: AuthoringTreatment;
  readonly verbose?: boolean;
}): ExperimentConfig {
  return {
    agent: `vercel-ai-gateway/${harnessId(options.benchmark.harness)}`,
    model: nativeModel(options.benchmark),
    evals:
      process.env.EVE_BENCHMARK_EVAL ??
      (options.evals ? [...options.evals] : [...publishedBenchmark.caseIds]),
    scripts: ["typecheck", "build"],
    runs: options.runs ?? 1,
    earlyExit: false,
    // Lower this when iterating on a case that stalls, so a hung turn surfaces
    // in minutes instead of consuming the full budget.
    timeout: Number(process.env.EVE_BENCHMARK_TIMEOUT ?? 900),
    sandbox: "vercel",
    copyFiles: "changed",
    setup: createNativeAuthoringSetup({
      packageSpec: options.packageSpec,
      revision: options.revision,
      treatment: options.treatment,
    }),
    agentOptions: { verbose: options.verbose ?? false },
  };
}

function nativeModel(benchmark: AuthoringBenchmarkModel): string {
  if (benchmark.harness !== "Claude Code") return benchmark.model;
  return benchmark.model.replace(/^anthropic\//u, "");
}
