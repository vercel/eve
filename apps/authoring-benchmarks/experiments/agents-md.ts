import type { ExperimentConfig } from "@vercel/agent-eval";
import { registerAgent } from "@vercel/agent-eval";

import { harnessAgent, imessageUserSimulator } from "../lib/harness-agent.js";

registerAgent(harnessAgent);

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
  agentOptions: { agentsMd: true, maxTurns: 2, userSimulator: imessageUserSimulator },
};

export default config;
