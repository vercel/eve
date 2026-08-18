import type { ExperimentConfig } from "@vercel/agent-eval";
import { registerAgent } from "@vercel/agent-eval";

import type { AuthoringBenchmarkModel, AuthoringTreatment } from "./benchmark-config.js";
import { createAuthoringAgent } from "./harness-agent.js";

export function authoringExperiment(options: {
  readonly archive: Uint8Array;
  readonly dependencyArchive: Uint8Array;
  readonly digest: string;
  readonly dependencyDigest: string;
  readonly runs?: number;
  readonly evals?: readonly string[];
  readonly benchmark: AuthoringBenchmarkModel;
  readonly treatment: AuthoringTreatment;
  readonly verbose?: boolean;
}): ExperimentConfig {
  const agent = createAuthoringAgent({
    model: options.benchmark.model,
    archive: options.archive,
    dependencyArchive: options.dependencyArchive,
    digest: options.digest,
    dependencyDigest: options.dependencyDigest,
  });
  registerAgent(agent);
  return {
    agent: agent.name,
    model: options.benchmark.model,
    evals: process.env.EVE_BENCHMARK_EVAL ?? (options.evals ? [...options.evals] : "*"),
    scripts: ["typecheck", "build"],
    runs: options.runs ?? 1,
    earlyExit: false,
    // Lower this when iterating on a case that stalls, so a hung turn surfaces
    // in minutes instead of consuming the full budget.
    timeout: Number(process.env.EVE_BENCHMARK_TIMEOUT ?? 900),
    sandbox: "vercel",
    copyFiles: "changed",
    agentOptions: {
      agentsMd: options.treatment === "guided",
      verbose: options.verbose ?? false,
    },
  };
}
