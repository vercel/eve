import type { ExperimentConfig } from "@vercel/agent-eval";
import { registerAgent } from "@vercel/agent-eval";

import { createAuthoringAgent } from "../lib/harness-agent.js";
import { authoringScenario } from "../lib/scenarios/index.js";

registerAgent(createAuthoringAgent(authoringScenario));

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
  agentOptions: { agentsMd: false },
};

export default config;
