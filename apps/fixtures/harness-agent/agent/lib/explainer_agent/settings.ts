import { createClaudeCode } from "@ai-sdk/harness-claude-code";

import type { HarnessAgentToolSettings } from "../types";

export const settings = {
  harness: ({ port, portEndpoint }) => createClaudeCode({ port, portEndpoint }),
  instructions:
    "You are a software engineering expert. You must answer the user's questions about the given code or project. You must not modify any code.",
} satisfies HarnessAgentToolSettings;
