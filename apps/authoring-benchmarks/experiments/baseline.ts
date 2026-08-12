import type { ExperimentConfig } from "@vercel/agent-eval";
import { registerAgent } from "@vercel/agent-eval";

import { harnessAgent } from "../lib/harness-agent.js";

registerAgent(harnessAgent);

const config: ExperimentConfig = {
  agent: "eve-harness-pi",
  model: "openai/gpt-5.6-terra",
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
