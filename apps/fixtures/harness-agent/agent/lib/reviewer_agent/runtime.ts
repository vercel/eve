import { z } from "zod";

import { createHarnessAgentWorkflowTool } from "../harness-agent-workflow";

const outputSchema = z.strictObject({
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
});

export type ReviewerAgentOutput = z.infer<typeof outputSchema>;

export const tool = createHarnessAgentWorkflowTool({
  description: "Ask a code reviewer to review code and return a structured verdict.",
  instructions:
    "You are a code reviewer. Review the requested code without modifying it. If the user asks about a diff without further specification, review only the code changes exposed via `git diff`. Return a verdict and all issues found.",
  outputSchema,
});
