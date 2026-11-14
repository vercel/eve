import { z } from "zod";

/**
 * Structured verdict the `reviewer` subagent must return.
 *
 * @remarks
 * Passed to the subagent turn as its `outputSchema`, so eve makes the child deliver exactly this
 * shape. Shared by the `review` tool, which returns it as-is, and the `check_style` tool, which
 * embeds it when it escalates an uncertain draft to the reviewer. The contract mirrors the
 * reviewer's `instructions.md`.
 */
export const REVIEW_SCHEMA = z.object({
  issues: z
    .array(
      z.object({
        fix: z.string().describe("A concrete suggested change."),
        quote: z
          .string()
          .describe("The offending excerpt, quoted from the draft."),
        rule: z
          .string()
          .describe("The rubric rule or reference the excerpt breaks."),
        severity: z.enum(["high", "medium", "low"]),
      })
    )
    .describe(
      "One entry per concrete problem; empty when the verdict is 'ready'."
    ),
  verdict: z
    .enum(["ready", "revise"])
    .describe(
      "'ready' = clean enough to send as-is; 'revise' = fix the issues first."
    ),
});
