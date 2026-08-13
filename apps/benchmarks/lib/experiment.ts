import type { ExperimentConfig } from "@vercel/agent-eval";
import { registerAgent } from "@vercel/agent-eval";

import { createAuthoringAgent } from "./harness-agent.js";
import { AUTHORING_MODEL } from "./paths.js";

export function authoringExperiment(options: {
  readonly archive: Uint8Array;
  readonly digest: string;
  readonly runs?: number;
  readonly verbose?: boolean;
}): ExperimentConfig {
  const agent = createAuthoringAgent({
    name: `eve-authoring-harness-${options.digest.slice(0, 12)}`,
    archive: options.archive,
    digest: options.digest,
  });
  registerAgent(agent);
  return {
    agent: agent.name,
    model: AUTHORING_MODEL,
    evals: process.env.EVE_BENCHMARK_EVAL ?? "*",
    scripts: ["typecheck", "build"],
    runs: options.runs ?? 1,
    earlyExit: options.runs === undefined,
    timeout: 900,
    sandbox: "vercel",
    copyFiles: "changed",
    agentOptions: { agentsMd: true, verbose: options.verbose ?? false },
  };
}
