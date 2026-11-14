/**
 * AI Gateway model ids used across the agent, kept in one place so a model change is one edit.
 *
 * @remarks
 * Every id is a Vercel AI Gateway id (`provider/model`). eve reads each model's context window
 * from the catalog recorded at build time, so an id must exist in the Gateway catalog.
 */

/**
 * Model for the root content assistant.
 */
export const ROOT_MODEL = "anthropic/claude-opus-5.5";

/**
 * Model for the fresh-context `reviewer` subagent.
 */
export const REVIEW_MODEL = "openai/gpt-6.1-sol";

/**
 * Research model for deep work: many sources, conflicting evidence, cross-domain synthesis.
 */
export const DEEP_RESEARCH_MODEL = "anthropic/claude-fable-5.2";

/**
 * Research model for routine lookups, and the researcher's fallback when the router fails.
 */
export const STANDARD_RESEARCH_MODEL = "anthropic/claude-opus-5.5-fast";

/**
 * Decision model behind both the researcher's model router (`auto` from `eve/models`) and the
 * `check_style` tool's judgment questions (`decide` from `eve/ai`).
 *
 * @remarks
 * A Gateway `evaluation` model implementing AI SDK decision specification `v4`. It answers typed
 * questions with probabilities; it does not generate text.
 */
export const DECISION_MODEL = "google/gemini-decision-1";
