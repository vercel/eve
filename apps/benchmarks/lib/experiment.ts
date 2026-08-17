import type { ExperimentConfig } from "@vercel/agent-eval";
import { registerAgent } from "@vercel/agent-eval";

import type { AuthoringTreatment } from "./benchmark-config.js";
import { AUTHORING_MODEL } from "./benchmark-config.js";
import { createAuthoringAgent } from "./harness-agent.js";

export function authoringExperiment(options: {
  readonly archive: Uint8Array;
  readonly digest: string;
  readonly dependencyDigest: string;
  readonly runs?: number;
  readonly treatment: AuthoringTreatment;
  readonly verbose?: boolean;
}): ExperimentConfig {
  const agent = createAuthoringAgent({
    name: `eve-authoring-harness-${options.digest.slice(0, 12)}-${options.treatment}`,
    archive: options.archive,
    digest: options.digest,
    dependencyDigest: options.dependencyDigest,
  });
  registerAgent(agent);
  return {
    agent: agent.name,
    model: AUTHORING_MODEL,
    evals: process.env.EVE_BENCHMARK_EVAL ?? "*",
    scripts: ["typecheck", "build"],
    runs: options.runs ?? 1,
    earlyExit: false,
    timeout: 900,
    sandbox: "vercel",
    copyFiles: "changed",
    agentOptions: {
      agentsMd: options.treatment === "guided",
      verbose: options.verbose ?? false,
    },
  };
}
