import { decide } from "eve/ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { DECISION_MODEL } from "../lib/models.js";
import { SURFACE_DESCRIPTIONS, SURFACES } from "../lib/surfaces.generated.js";

/**
 * Choice key for a request that doesn't say which surface it is for.
 */
const NOT_STATED = "not-stated";

/**
 * Minimum probability for the chosen surface to count as a confident answer.
 *
 * @remarks
 * Decision-model probabilities are estimates, not calibrated confidence, so anything below this
 * is reported as unsure and the agent asks the writer instead of guessing.
 */
const CONFIDENT = 0.75;

/**
 * Result shape for surface detection.
 *
 * @remarks
 * Declared as the tool's `outputSchema` so eve validates and types the `execute` return.
 */
const OUTPUT_SCHEMA = z.object({
  outcome: z
    .enum(["confident", "unsure", "decide_error"])
    .describe(
      "'confident' = `surface` is set; 'unsure' = the request doesn't make the surface clear; " +
        "'decide_error' = the decision model failed. Ask the writer unless 'confident'."
    ),
  probability: z
    .number()
    .nullable()
    .describe(
      "The decision model's estimate (0-1) for its choice, when it gave one."
    ),
  surface: z
    .enum(SURFACES)
    .nullable()
    .describe("The detected surface, or null when the writer should be asked."),
});

/**
 * Tool that works out which content surface a request is for.
 *
 * @remarks
 * One `decide` choice question from `eve/ai`: the options are every surface, described by its
 * style skill's own `description` (generated into {@link SURFACE_DESCRIPTIONS}, so a new skill
 * folder becomes a new option), plus an explicit {@link NOT_STATED} option so an unclear request
 * has somewhere to go other than the least-wrong surface. The answer counts only when it names
 * a surface with a probability of at least {@link CONFIDENT}; a missing probability, a low one,
 * or a decision-model failure all come back as "ask the writer".
 */
export default defineTool({
  description:
    "Work out which content surface (blog, LinkedIn, X, release notes, newsletter) a request " +
    "is for when the writer hasn't named one. Pass the writer's request. Returns the surface " +
    "when the request makes it clear; otherwise returns null, and you should ask the writer.",
  /**
   * Ask the decision model which surface the request is for.
   *
   * @param input - Validated tool input.
   * @param input.request - The writer's request, in their own words.
   * @param ctx - Tool context; supplies the call's `abortSignal`.
   * @returns The detected `surface` (or null), the `outcome`, and the choice's `probability`.
   */
  async execute({ request }, ctx) {
    try {
      const { answers } = await decide({
        model: DECISION_MODEL,
        questions: {
          surface: {
            criteria: {
              ...SURFACE_DESCRIPTIONS,
              [NOT_STATED]:
                "The request doesn't say or clearly imply which of these it is for.",
            },
            instructions: "Which kind of content is the writer asking for?",
            type: "choice",
          },
        },
        signal: ctx.abortSignal,
        state: { request },
      });
      const { choice, probabilities } = answers.surface;
      const probability = probabilities?.[choice] ?? null;
      const confident =
        choice !== NOT_STATED &&
        probability !== null &&
        probability >= CONFIDENT;
      return confident
        ? { outcome: "confident" as const, probability, surface: choice }
        : { outcome: "unsure" as const, probability, surface: null };
    } catch (error) {
      console.warn("detect_surface: the decision model failed.", error);
      return {
        outcome: "decide_error" as const,
        probability: null,
        surface: null,
      };
    }
  },
  inputSchema: z.object({
    request: z.string().min(1).max(8000),
  }),
  outputSchema: OUTPUT_SCHEMA,
});
