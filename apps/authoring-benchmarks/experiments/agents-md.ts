import type { ExperimentConfig } from "@vercel/agent-eval";
import { registerAgent } from "@vercel/agent-eval";

import { createAuthoringAgent } from "../lib/harness-agent.js";

registerAgent(createAuthoringAgent());

const config: ExperimentConfig = {
  agent: "eve-harness-pi",
  model: "claude-sonnet-4-6",
  evals: "author-000-imessage",
  scripts: ["typecheck", "build"],
  runs: 1,
  earlyExit: true,
  timeout: 900,
  sandbox: "vercel",
  copyFiles: "changed",
  agentOptions: { agentsMd: true },
};

export default config;
