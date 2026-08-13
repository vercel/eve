import type { ExperimentConfig } from "@vercel/agent-eval";
import { registerAgent } from "@vercel/agent-eval";

import { createAuthoringAgent } from "./harness-agent.js";

export function authoringExperiment(options: {
  readonly repository: string;
  readonly revision: string;
  readonly runs?: number;
}): ExperimentConfig {
  const agent = createAuthoringAgent({
    name: `eve-authoring-harness-${options.revision.slice(0, 12)}`,
    repository: options.repository,
    revision: options.revision,
  });
  registerAgent(agent);
  return {
    agent: agent.name,
    model: "claude-sonnet-4-6",
    evals: process.env.EVE_BENCHMARK_EVAL ?? "*",
    scripts: ["typecheck", "build"],
    runs: options.runs ?? 1,
    earlyExit: options.runs === undefined,
    timeout: 900,
    sandbox: "vercel",
    copyFiles: "changed",
    agentOptions: { agentsMd: true },
  };
}
