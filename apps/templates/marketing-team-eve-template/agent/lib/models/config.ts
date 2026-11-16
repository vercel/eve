/**
 * Every model id the team runs on, in one place.
 *
 * @remarks
 * Each id is a Vercel AI Gateway model id. Agents and tools import the constant for their role
 * instead of writing an id inline, so trying a different tier for one role is a one-line change
 * here.
 *
 * @packageDocumentation
 */

/**
 * The model the lead runs on.
 *
 * @remarks
 * The lead routes work and writes briefs; it does not produce deliverables. That makes it the first
 * role to try on a cheaper tier when cost matters more than routing quality.
 */
export const LEAD_MODEL = "anthropic/claude-opus-5.5";

/**
 * The model every specialist runs on.
 *
 * @remarks
 * Specialists do the writing, research, and review, so this is the id that most affects the quality
 * of what the team hands back.
 */
export const SPECIALIST_MODEL = "anthropic/claude-opus-5.5";

/**
 * The model that answers decision questions.
 *
 * @remarks
 * Used by `judgeRules` in `lib/decisions/config.ts` and by the eval judge. Swap it for any decision
 * model the Gateway serves and your team's provider allow list permits.
 */
export const DECISION_MODEL = "google/gemini-decision-1";
