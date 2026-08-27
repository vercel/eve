import { defineAgent } from "eve";
import { MODELS } from "#lib/models.js";

/**
 * Station 1: triage.
 *
 * @remarks
 * Runs on a fast, cheap model because classification is a shaping step, not
 * an analysis step. The station receives only text (the work item plus any
 * thread context the orchestrator packs into `message`) and returns the
 * structured classification the rest of the pipeline routes on.
 * `needs_clarification` is the pipeline's stop signal; the orchestrator asks
 * the human instead of proceeding on guesses.
 */
export default defineAgent({
  description:
    "Classify an incoming work item: type (bug/feature/refactor/question/chore/security), " +
    "priority, complexity, affected area, and whether it is actionable or needs " +
    "clarification. Fast triage only; no analysis or implementation. The caller passes " +
    "the work item verbatim in the message.",
  model: MODELS.classifier,
  outputSchema: {
    additionalProperties: false,
    properties: {
      actionable: {
        description: "Whether the request contains enough information to act on.",
        type: "boolean",
      },
      affected_area: {
        description:
          "Best guess at the component, service, or layer involved (e.g. 'frontend/auth', 'API', 'CI pipeline', 'unknown').",
        type: "string",
      },
      complexity: {
        enum: ["trivial", "small", "medium", "large"],
        type: "string",
      },
      needs_clarification: {
        description:
          "True when the request is ambiguous, contradictory, or missing essential details; the questions to ask go in `questions`.",
        type: "boolean",
      },
      priority: {
        enum: ["critical", "high", "medium", "low"],
        type: "string",
      },
      questions: {
        description:
          "The specific clarifying questions to ask; empty unless needs_clarification is true.",
        items: { type: "string" },
        type: "array",
      },
      summary: {
        description: "One-sentence restatement of the work item.",
        type: "string",
      },
      type: {
        enum: ["bug", "feature", "refactor", "question", "chore", "security"],
        type: "string",
      },
    },
    required: [
      "type",
      "priority",
      "complexity",
      "affected_area",
      "actionable",
      "needs_clarification",
      "questions",
      "summary",
    ],
    type: "object",
  },
});
