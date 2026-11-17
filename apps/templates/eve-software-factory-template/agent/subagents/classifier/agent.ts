import { defineAgent } from "eve";
import { MODELS } from "../../lib/models.js";

/**
 * Clarification station and fallback when decision-model triage is unavailable.
 *
 * @remarks
 * Runs on a fast, cheap model because classification is a shaping step, not
 * an analysis step. The station receives only text (the work item plus any
 * thread context the orchestrator packs into `message`) and returns the
 * structured classification the rest of the pipeline routes on.
 * `needs_clarification` is the pipeline's stop signal; the orchestrator asks
 * the human instead of proceeding on guesses.
 *
 * `tool: false` hides the station from the orchestrator; it calls it through
 * the `run_classifier` workflow tool, which attaches the output schema.
 * The wrapper cannot share this name: the compiler rejects a tool and a local
 * subagent with the same public name, even with `tool: false`.
 */
export default defineAgent({
  description:
    "Write clarification questions for a work item that typed triage could not route, " +
    "or classify it when the decision model is unavailable: type (bug/feature/refactor/question/chore/security), " +
    "priority, complexity, affected area, and whether it is actionable or needs " +
    "clarification. Fast triage only; no analysis or implementation. The caller passes " +
    "the work item verbatim in the message.",
  model: MODELS.classifier,
  tool: false,
});
