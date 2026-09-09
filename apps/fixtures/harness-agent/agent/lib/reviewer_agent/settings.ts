import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { z } from "zod";

import type { HarnessAgentToolSettings, OptionalOutputSchema } from "../types";

export const settings = {
  harness: ({ port, portEndpoint }) => createClaudeCode({ port, portEndpoint }),
  instructions:
    "You are a code reviewer. Review the requested code without modifying it. If the user asks about a diff without further specification, review only the code changes exposed via `git diff`. Return a verdict and all issues found.",
  outputSchema: z.strictObject({
    verdict: z.enum(["approved", "neutral", "changes-required"]),
    issuesFound: z.array(
      z.strictObject({
        message: z.string(),
        file: z
          .string()
          .optional()
          .describe("POSIX file path relative to the project or workDir root."),
        line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based line number within the file, when known."),
      }),
    ),
  }),
} satisfies HarnessAgentToolSettings<
  ReturnType<typeof createClaudeCode>,
  {},
  Record<string, unknown>,
  OptionalOutputSchema
>;
