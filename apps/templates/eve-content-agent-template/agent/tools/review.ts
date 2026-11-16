import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { REVIEW_SCHEMA } from "../lib/review-schema.js";
import { askSubagent } from "../lib/subagent.js";

/**
 * Model-facing wrapper around the `reviewer` subagent that returns a structured verdict.
 *
 * @remarks
 * The subagent sets `tool: false`, so this tool is the model's only way to reach it, and
 * {@link askSubagent} requests the structured result as the turn's `outputSchema`. The tool
 * can't share the subagent's name — eve's compiler rejects a tool and a subagent with the same
 * public name — hence `review`.
 *
 * Each call opens a fresh child session that ends when the call finishes, so every review is a
 * genuinely fresh-eyes pass that never saw the source material, the drafting reasoning, or an
 * earlier review. The call blocks the root's turn until the verdict arrives, so the root can act
 * on it before proposing the draft. A failed child turn fails the call with the child's error.
 *
 * @see The reviewer's rubric and verdict contract in `agent/subagents/reviewer/instructions.md`.
 */
export default defineWorkflowTool({
  description:
    "Review a finished draft with fresh context against the active surface's style rubric " +
    "(voice, AI-tells, plain English, structure, specs) before it goes to the writer. The " +
    "reviewer does not see this conversation, so put the surface and the full draft in " +
    "`message`; it loads the matching rubric itself and returns a verdict.",
  /**
   * Run one review turn in a fresh `reviewer` session and return its structured verdict.
   *
   * @param input - Validated tool input.
   * @param input.message - The surface and the full draft to review.
   * @param ctx - Workflow tool context; supplies `agent()` and the call's `abortSignal`.
   * @returns The reviewer's `verdict` and `issues`.
   * @throws When the reviewer's turn fails or is cancelled before it delivers a verdict.
   */
  async execute({ message }, ctx) {
    "use workflow";
    return await askSubagent(ctx, "reviewer", message, REVIEW_SCHEMA);
  },
  inputSchema: z.object({
    message: z
      .string()
      .min(1)
      .describe(
        "The surface (e.g. 'blog') and the full draft. The reviewer sees nothing else."
      ),
  }),
  outputSchema: REVIEW_SCHEMA,
});
