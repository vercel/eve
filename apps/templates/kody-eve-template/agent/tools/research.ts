import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

/**
 * The cited result the researcher returns for each request.
 *
 * @remarks
 * Requested per turn through `send({ outputSchema })`, so the researcher's final answer is
 * validated against this shape before it reaches the root.
 */
const researchResultSchema = z.strictObject({
  findings: z
    .array(
      z.strictObject({
        claim: z
          .string()
          .describe("A single, specific factual claim the caller can rely on."),
        confidence: z
          .enum(["high", "medium", "low"])
          .describe(
            "'high' = multiple strong independent sources; 'low' = single or weaker source."
          ),
        notes: z
          .string()
          .describe(
            "Caveats: date-sensitivity, scope limits, or where sources disagree."
          ),
        sources: z
          .array(
            z.strictObject({
              title: z
                .string()
                .describe("The source's title or publication name."),
              url: z.string().describe("The source URL, as visited."),
            })
          )
          .min(1)
          .describe(
            "The real, fetched sources backing the claim; never empty, never invented."
          ),
      })
    )
    .describe(
      "One entry per verified factual claim; every entry carries at least one real source."
    ),
  gaps: z
    .array(z.string())
    .describe(
      "What could not be found or verified; surfaced to the caller rather than guessed at."
    ),
  summary: z
    .string()
    .describe(
      "A 1-3 sentence synthesis of what the research establishes, for the root to scan first."
    ),
});

/**
 * Tool that delegates a research question to the `researcher` subagent and returns its cited
 * findings.
 *
 * @remarks
 * A workflow tool: each call opens a fresh session with the researcher via `ctx.agent()`, sends
 * the root's `message`, and waits durably (holding no compute) for the turn's structured result.
 * The subagent sets `tool: false`, so this is the only model-facing way to reach it. A failed or
 * cancelled research turn comes back as `error` rather than throwing, so the root can tell the
 * user what it couldn't verify.
 *
 * The tool is named `research`, not `researcher`: eve's docs allow a tool to share a
 * `tool: false` subagent's name, but its compiled-artifact validation (0.83) still rejects the
 * shared name.
 */
export default defineWorkflowTool({
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links you " +
    "don't already have. The researcher runs refined searches against reliable sources and " +
    "returns cited findings with confidence levels, plus the gaps it couldn't verify. It does " +
    "not see this conversation, so put the question and everything you already know in the " +
    "message.",
  async execute({ message }, ctx) {
    "use workflow";
    const response = await ctx.agent("researcher").send(message, {
      outputSchema: researchResultSchema,
      signal: ctx.abortSignal,
    });
    const result = await response.result();
    if (result.status === "failed") {
      return { error: result.error?.message ?? "The research turn failed." };
    }
    if (result.data === undefined) {
      return {
        error: "The research was cancelled before it returned findings.",
      };
    }
    return result.data;
  },
  inputSchema: z.object({
    message: z
      .string()
      .min(1)
      .describe(
        "Everything the researcher needs: the specific question, the context you already have, and any constraints (recency, region, source type)."
      ),
  }),
});
