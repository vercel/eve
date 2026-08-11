import type { ExperimentConfig } from "@vercel/agent-eval";

import { setupAuthoringEval } from "../lib/setup.js";

const config: ExperimentConfig = {
  agent: "vercel-ai-gateway/claude-code",
  model: "claude-sonnet-4-6",
  evals: "author-000-imessage",
  scripts: ["typecheck", "build"],
  runs: 1,
  earlyExit: true,
  timeout: 900,
  sandbox: "auto",
  copyFiles: "changed",
  setup: (sandbox) => setupAuthoringEval(sandbox, { syntheticImessage: true }),
};

export default config;
