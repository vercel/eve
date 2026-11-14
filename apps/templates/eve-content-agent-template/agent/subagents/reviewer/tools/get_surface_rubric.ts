import { defineTool } from "eve/tools";
import { z } from "zod";
import { SURFACES } from "../../../lib/surfaces.generated.js";
import { REVIEWER_RUBRIC } from "../lib/rubric.generated.js";

/**
 * Result shape: exactly the rubric the reviewer judges a draft against — nothing it doesn't use.
 *
 * @remarks
 * Declared as the tool's `outputSchema` so eve validates and types the `execute` return. All
 * fields are raw Markdown pulled verbatim from the bundled rubric.
 */
const OUTPUT_SCHEMA = z.object({
  aiPhrasesToAvoid: z.string(),
  bestPractices: z.string(),
  plainEnglishAlternatives: z.string(),
  specs: z.string(),
});

/**
 * Tool that returns the review rubric for a content surface.
 *
 * @remarks
 * The reviewer subagent inherits no skills, so it can't read the style references the way the
 * root does. This tool serves them from {@link REVIEWER_RUBRIC}, a module generated at build time
 * by `scripts/sync-shared.mjs` from `shared-references/` and each skill's `references/`. It runs
 * in the app runtime with no sandbox, so one call returns the house lists plus the surface's
 * best-practices and specs in a single round-trip. The `surface` input is constrained to the
 * generated {@link SURFACES} enum, matching the `check_style` surface set.
 */
export default defineTool({
  description:
    "Return the review rubric for a content surface: the house AI-phrases-to-avoid and " +
    "plain-English lists, plus that surface's best-practices checklist and format specs. " +
    "Call this once with the surface the writer named before reviewing the draft.",
  /**
   * Look up the bundled rubric for `surface`.
   *
   * @param input - Validated tool input.
   * @param input.surface - Content surface to fetch the rubric for.
   * @returns The house lists plus the surface's best-practices and specs.
   */
  execute({ surface }) {
    const rubric = REVIEWER_RUBRIC.surfaces[surface];
    return {
      aiPhrasesToAvoid: REVIEWER_RUBRIC.house.aiPhrasesToAvoid,
      bestPractices: rubric.bestPractices,
      plainEnglishAlternatives: REVIEWER_RUBRIC.house.plainEnglishAlternatives,
      specs: rubric.specs,
    };
  },
  inputSchema: z.object({
    surface: z
      .enum(SURFACES)
      .describe("The content surface whose rubric to return."),
  }),
  outputSchema: OUTPUT_SCHEMA,
});
