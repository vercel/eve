import { type DecisionQuestion, decide } from "eve/ai";
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { findBannedWords } from "../lib/banned-words.js";
import { DECISION_MODEL } from "../lib/models.js";
import { REVIEW_SCHEMA } from "../lib/review-schema.js";
import { askSubagent } from "../lib/subagent.js";
import { SURFACES, type Surface } from "../lib/surfaces.generated.js";
import { REVIEWER_RUBRIC } from "../subagents/reviewer/lib/rubric.generated.js";

/**
 * Maximum draft length accepted, in characters.
 *
 * @remarks
 * Bounds the work done per call and the size of accepted input. Comfortably larger than any
 * realistic draft for the supported surfaces, and well inside the decision model's context
 * window together with the rubric.
 */
const MAX_TEXT_LENGTH = 100_000;

/**
 * Lower edge of the uncertain band for a judgment probability.
 *
 * @remarks
 * A probability at or below this is a confident "fails the rule". Decision-model probabilities
 * are estimates, not calibrated confidence, so the band is deliberately wide.
 */
const UNCERTAIN_LOW = 0.25;

/**
 * Upper edge of the uncertain band for a judgment probability.
 *
 * @remarks
 * A probability above this is a confident "passes the rule". Anything from
 * {@link UNCERTAIN_LOW} (exclusive) to this value (inclusive) is too close to call and sends the
 * draft to the `reviewer` subagent.
 */
const UNCERTAIN_HIGH = 0.75;

/**
 * One judgment rule's outcome from the decision model.
 */
const CHECK_SCHEMA = z.object({
  passed: z
    .boolean()
    .describe("True when the probability clears the confident-pass threshold."),
  probability: z
    .number()
    .describe(
      "The decision model's estimate (0-1) that the draft follows the rule."
    ),
  rule: z.string().describe("The judgment rule that was checked."),
});

/**
 * Result shape for a style check.
 *
 * @remarks
 * Declared as the tool's `outputSchema` so eve validates and types the `execute` return.
 * `escalation` records why the reviewer ran, so a failing decision model shows up as
 * `decide_error` instead of being hidden behind the fallback.
 */
const OUTPUT_SCHEMA = z.object({
  checks: z
    .array(CHECK_SCHEMA)
    .describe(
      "One entry per judgment rule; empty when the decision model failed."
    ),
  escalation: z
    .enum(["none", "uncertain", "decide_error"])
    .describe(
      "'none' = the decision model was confident on every rule; 'uncertain' = at least one " +
        "rule was too close to call, so the reviewer judged the draft; 'decide_error' = the " +
        "decision model failed, so the reviewer judged the draft."
    ),
  ok: z
    .boolean()
    .describe(
      "True only when no banned words were found and the judgment rules passed: every check " +
        "passed without escalation, or the escalated review's verdict is 'ready'."
    ),
  review: REVIEW_SCHEMA.optional().describe(
    "The reviewer's verdict and issues; present only when the check escalated."
  ),
  violations: z
    .array(z.string())
    .describe("One note per banned word found in the draft."),
});

/**
 * One judgment rule's outcome, as reported in `checks`.
 */
type StyleCheck = z.infer<typeof CHECK_SCHEMA>;

/**
 * Judgment rules the decision model answers, keyed by the rule name reported in `checks`.
 *
 * @remarks
 * Each is a yes/no question about the draft, judged against the rubric passed as decision
 * state. A regex can't judge any of these, which is why they go to a model.
 */
const RULES = {
  avoidsAiPhrasing:
    "Is the draft free of the AI-sounding phrases and patterns listed under `aiPhrasesToAvoid`?",
  fitsFormatSpecs:
    "Does the draft fit the format specs for its surface listed under `specs` (length, " +
    "structure, formatting)?",
  followsBestPractices:
    "Does the draft follow the best practices for its surface listed under `bestPractices`?",
  usesPlainEnglish:
    "Is the draft written in plain English, preferring the simpler wording listed under " +
    "`plainEnglishAlternatives`?",
} as const;

/**
 * A yes/no decision question, the only kind `check_style` asks.
 */
type BooleanQuestion = Extract<DecisionQuestion, { type: "boolean" }>;

/**
 * The {@link RULES} as `decide` questions, built once at module load.
 *
 * @remarks
 * Every rule shares the same true/false criteria, so a rule is added by adding one entry to
 * {@link RULES}; nothing else in this file names the individual rules.
 */
const QUESTIONS = Object.fromEntries(
  Object.entries(RULES).map(([rule, instructions]) => [
    rule,
    {
      criteria: {
        false: "The draft breaks the rule in at least one clear place.",
        true: "The draft follows the rule throughout.",
      },
      instructions,
      type: "boolean",
    },
  ])
) as Record<keyof typeof RULES, BooleanQuestion>;

/**
 * Ask the decision model each judgment rule about a draft.
 *
 * @remarks
 * A `"use step"` helper, so a replayed workflow reuses the recorded answers instead of asking
 * the decision model again. The state carries the draft plus the same rubric text the reviewer
 * reads: the house lists and the surface's best-practices and specs from
 * {@link REVIEWER_RUBRIC}.
 *
 * @param surface - Content surface whose rubric applies.
 * @param text - Draft text to judge.
 * @param abortSignal - The tool call's abort signal, so a cancelled call cancels the decision.
 * @returns One check per rule, with the probability that the draft follows it.
 * @throws When the decision model is unavailable or returns an error after its retries.
 */
async function judgeStyle(
  surface: Surface,
  text: string,
  abortSignal: AbortSignal
): Promise<StyleCheck[]> {
  "use step";
  const { answers } = await decide({
    model: DECISION_MODEL,
    questions: QUESTIONS,
    signal: abortSignal,
    state: {
      draft: text,
      rubric: {
        ...REVIEWER_RUBRIC.house,
        ...REVIEWER_RUBRIC.surfaces[surface],
      },
      surface,
    },
  });
  return Object.entries(answers).map(([rule, { probability }]) => ({
    passed: probability > UNCERTAIN_HIGH,
    probability,
    rule,
  }));
}

/**
 * Whether a check is too close to call.
 *
 * @param check - One rule's outcome from the decision model.
 * @returns True when its probability is not a finite number or is inside the uncertain band.
 */
const isUncertain = ({ probability }: StyleCheck): boolean =>
  !Number.isFinite(probability) ||
  (probability > UNCERTAIN_LOW && probability <= UNCERTAIN_HIGH);

/**
 * Tool that checks a draft against the active surface's style rules in three stages.
 *
 * @remarks
 * 1. **Deterministic.** A banned-words pass ({@link findBannedWords}) over the list bundled from
 *    the surface's style skill. Always runs and is always reported in `violations`.
 * 2. **Decision model.** `decide` from `eve/ai` answers the judgment {@link RULES} with a
 *    probability each.
 * 3. **Fallback.** When the decision model fails, or any probability falls in the uncertain
 *    band, the draft goes to the `reviewer` subagent, whose verdict then decides the judgment
 *    rules. `ctx.agent()` exists only in the workflow body, so the escalation happens here and
 *    not in the step.
 *
 * The `surface` input is constrained to the generated {@link SURFACES} enum. Run it before
 * proposing a draft to the writer.
 */
export default defineWorkflowTool({
  description:
    "Check a draft against the active surface's style rules. Returns banned-word `violations`, " +
    "a pass/fail `checks` entry per judgment rule (plain English, AI-sounding phrasing, format " +
    "specs, best practices), and, when a rule was too close to call, a fresh-eyes `review` " +
    "with a verdict and issues. Run before proposing a draft to the writer.",
  /**
   * Run the banned-words pass, the decision-model rules, and the reviewer fallback if needed.
   *
   * @param input - Validated tool input.
   * @param input.surface - Content surface whose style skill supplies the rules.
   * @param input.text - Draft text to check.
   * @param ctx - Workflow tool context; supplies `agent()` and the call's `abortSignal`.
   * @returns `ok`, banned-word `violations`, per-rule `checks`, the `escalation` reason, and the
   * reviewer's `review` when the check escalated.
   * @throws When the check escalates and the reviewer's turn fails or returns no verdict.
   */
  async execute({ surface, text }, ctx) {
    "use workflow";
    const violations = findBannedWords(surface, text).map(
      (word) => `Avoid "${word}" per the ${surface} style guide.`
    );
    const clean = violations.length === 0;

    const judged = await judgeStyle(surface, text, ctx.abortSignal).catch(
      (error: unknown) => {
        console.warn(
          "check_style: the decision model failed; escalating to the reviewer.",
          error
        );
        return null;
      }
    );
    const checks = judged ?? [];
    if (judged && !judged.some(isUncertain)) {
      return {
        checks,
        escalation: "none" as const,
        ok: clean && checks.every((check) => check.passed),
        violations,
      };
    }

    const review = await askSubagent(
      ctx,
      "reviewer",
      `Surface: ${surface}\n\nDraft:\n${text}`,
      REVIEW_SCHEMA
    );
    return {
      checks,
      escalation: judged ? ("uncertain" as const) : ("decide_error" as const),
      ok: clean && review.verdict === "ready",
      review,
      violations,
    };
  },
  inputSchema: z.object({
    surface: z.enum(SURFACES),
    text: z.string().min(1).max(MAX_TEXT_LENGTH),
  }),
  outputSchema: OUTPUT_SCHEMA,
});
