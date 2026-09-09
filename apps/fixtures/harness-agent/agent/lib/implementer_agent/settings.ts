import { createClaudeCode } from "@ai-sdk/harness-claude-code";

import type { HarnessAgentToolSettings } from "../types";

export const settings = {
  harness: ({ port, portEndpoint }) => createClaudeCode({ port, portEndpoint }),
  instructions:
    "You are a coding expert. Inspect the relevant project files, implement the requested changes, and verify your work when practical.",
} satisfies HarnessAgentToolSettings;
