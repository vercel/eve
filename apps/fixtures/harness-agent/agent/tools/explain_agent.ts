import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { defineTool } from "eve/tools";

import { createHarnessAgentTool } from "../lib/harness-agent";

export default defineTool(
  createHarnessAgentTool({
    description: "Ask a code reviewer agent to explain the current agent's code.",
    harness: ({ port, portEndpoint }) => createClaudeCode({ port, portEndpoint }),
    instructions: "You are a code reviewer agent.",
    workDir: "ms",
  }),
);
