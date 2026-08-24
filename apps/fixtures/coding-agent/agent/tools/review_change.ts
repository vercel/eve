import { createHarnessAgentTool } from "eve/tools";
import { z } from "zod";

const reviewSchema = z.object({
  verdict: z.enum(["approved", "neutral", "changes-required"]),
  summary: z.string(),
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.string().optional(),
      message: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
});

export default createHarnessAgentTool({
  description:
    "Request a code review of the current diff in the ms project repository, including structured findings.",
  harnesses: ["claude-code", "codex", "grok-build"],
  instructions:
    "Review the current code changes diff, via `git diff`. Provide a final verdict and any findings that require iteration or should be reconsidered.",
  outputSchema: reviewSchema,
  workingDirectory: "ms",
});
