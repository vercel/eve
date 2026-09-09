import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { defineTool } from "eve/tools";

import { createHarnessAgentTool } from "../lib/harness-agent";

export default defineTool(
  createHarnessAgentTool({
    description: "Ask a software engineering expert to explain the current agent's code.",
    harness: ({ port, portEndpoint }) => createClaudeCode({ port, portEndpoint }),
    instructions:
      "You are a software engineering expert. You must answer the user's questions about the given code or project. You must not modify any code.",
  }),
);
