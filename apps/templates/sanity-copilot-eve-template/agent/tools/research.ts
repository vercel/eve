import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { askSubagent } from "../lib/subagent.js";

/**
 * One real, fetched source backing a finding.
 */
const SOURCE_SCHEMA = z.object({
  title: z.string().describe("The source's title or publication name."),
  url: z.string().describe("The source URL, as visited."),
});

/**
 * Structured result the `researcher` subagent must return: cited findings plus the gaps it
 * couldn't verify.
 *
 * @remarks
 * Passed to the subagent turn as its `outputSchema`, so eve makes the child deliver exactly this
 * shape, and declared as this tool's `outputSchema`, so the root receives it typed and validated.
 * The contract mirrors the researcher's `instructions.md`.
 */
const RESEARCH_SCHEMA = z.object({
  findings: z
    .array(
      z.object({
        claim: z
          .string()
          .describe("A single, specific factual claim the draft can rely on."),
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
          .array(SOURCE_SCHEMA)
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
      "What could not be found or verified; surfaced to the user rather than guessed at."
    ),
  summary: z
    .string()
    .describe(
      "A 1-3 sentence synthesis of what the research establishes, for the root to scan first."
    ),
});

/**
 * Maximum research message length accepted, in characters.
 *
 * @remarks
 * The researcher's model router (`auto` from `eve/models`) rejects a message over 16,000
 * characters before any provider call, and its `fallback` does not cover that case. The cap
 * leaves room for the `Research depth:` prefix this tool adds.
 */
const MAX_MESSAGE_LENGTH = 15_000;

/**
 * Model-facing wrapper around the `researcher` subagent that returns structured, cited findings.
 *
 * @remarks
 * The subagent sets `tool: false`, so this tool is the model's only way to reach it, and
 * {@link askSubagent} requests the structured result as the turn's `outputSchema`. The tool
 * can't share the subagent's name (eve's compiler rejects a tool and a subagent with the same
 * public name), hence `research`.
 *
 * Each call opens a fresh child session that ends when the call finishes, so the researcher
 * never sees the thread or earlier research. That isolation forces it to ground every
 * claim in a fetched source. The researcher's model is chosen per call by a decision model that
 * reads this message, so an optional `depth` is prefixed to it as an explicit routing signal:
 * `deep` steers toward the stronger research model, `quick` and `standard` toward the routine
 * one. Without `depth` the router judges from the question alone. The call blocks the root's
 * turn until the findings arrive. A failed child turn fails the call with the child's error.
 *
 * @see The researcher's methodology and output contract in
 * `agent/subagents/researcher/instructions.md`.
 */
export default defineWorkflowTool({
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links the " +
    "task needs but the Sanity project's content doesn't hold. Runs refined searches against " +
    "reliable sources and returns cited findings with confidence levels, plus the gaps it " +
    "couldn't verify. The researcher does not see this conversation, so put the question and " +
    "every piece of known context and constraints (recency, region, source type) in " +
    "`message`. Set `depth` to " +
    "'deep' for multi-source or contested topics and 'quick' for a single fact or link; omit " +
    "it to let the router judge from the question.",
  /**
   * Run one research turn in a fresh `researcher` session and return its structured result.
   *
   * @param input - Validated tool input.
   * @param input.depth - Optional routing hint for how much research the question needs.
   * @param input.message - Everything the researcher needs: the question, context, constraints.
   * @param ctx - Workflow tool context; supplies `agent()` and the call's `abortSignal`.
   * @returns The researcher's `summary`, cited `findings`, and `gaps`.
   * @throws When the researcher's turn fails or is cancelled before it delivers a result.
   */
  async execute({ depth, message }, ctx) {
    "use workflow";
    const prompt = depth ? `Research depth: ${depth}\n\n${message}` : message;
    return await askSubagent(ctx, "researcher", prompt, RESEARCH_SCHEMA);
  },
  inputSchema: z.object({
    depth: z
      .enum(["quick", "standard", "deep"])
      .optional()
      .describe(
        "How much research the question needs: 'quick' = one fact or link; 'standard' = a few " +
          "reliable sources; 'deep' = many sources, contested or technical evidence."
      ),
    message: z
      .string()
      .min(1)
      .max(MAX_MESSAGE_LENGTH)
      .describe(
        "The research question plus all relevant context and constraints. The researcher sees " +
          "nothing else."
      ),
  }),
  outputSchema: RESEARCH_SCHEMA,
});
