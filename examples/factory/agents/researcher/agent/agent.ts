import { defineAgent } from "eve";
import { MODELS } from "#lib/models.js";

/**
 * Fresh-context web-research subagent.
 *
 * @remarks
 * The root delegates here when a task needs an outside fact: a statistic, a competitor detail,
 * a primary-source link, or a claim to verify. The researcher runs in a fresh child session and
 * inherits none of the root's skills, connections, or tools — only the framework default harness,
 * whose `web_search` and `web_fetch` cover web research with no extra wiring. It works solely
 * from what the root packs into `message` plus what it fetches, so every claim must be grounded
 * in a real source: the root weaves in only cited `findings` and surfaces `gaps` to the user.
 *
 * `description` is what the root reads to decide when to delegate; `outputSchema` makes the
 * findings a structured, cited result it can act on directly.
 *
 * @see The research methodology and output contract in this folder's `instructions.md`.
 */
export default defineAgent({
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links the " +
    "caller doesn't already have. Runs refined searches against reliable sources and returns " +
    "cited findings with confidence levels, plus the gaps it couldn't verify. May save a " +
    "long research memo as an artifact and return its id for later stations. The caller " +
    "passes the question and any known context in the message.",
  model: MODELS.researcher,
  outputSchema: {
    additionalProperties: false,
    properties: {
      artifact_id: {
        description:
          "Id of the saved research-notes artifact holding the full memo, or null when none was saved.",
        type: ["string", "null"],
      },
      findings: {
        description:
          "One entry per verified factual claim; every entry carries at least one real source.",
        items: {
          additionalProperties: false,
          properties: {
            claim: {
              description: "A single, specific factual claim the caller can rely on.",
              type: "string",
            },
            confidence: {
              description:
                "'high' = multiple strong independent sources; 'low' = single or weaker source.",
              enum: ["high", "medium", "low"],
              type: "string",
            },
            notes: {
              description: "Caveats: date-sensitivity, scope limits, or where sources disagree.",
              type: "string",
            },
            sources: {
              description:
                "The real, fetched sources backing the claim; never empty, never invented.",
              items: {
                additionalProperties: false,
                properties: {
                  title: {
                    description: "The source's title or publication name.",
                    type: "string",
                  },
                  url: {
                    description: "The source URL, as visited.",
                    type: "string",
                  },
                },
                required: ["url", "title"],
                type: "object",
              },
              minItems: 1,
              type: "array",
            },
          },
          required: ["claim", "sources", "confidence", "notes"],
          type: "object",
        },
        type: "array",
      },
      gaps: {
        description:
          "What could not be found or verified; surfaced to the caller rather than guessed at.",
        items: { type: "string" },
        type: "array",
      },
      summary: {
        description:
          "A 1-3 sentence synthesis of what the research establishes, for the root to scan first.",
        type: "string",
      },
    },
    required: ["summary", "findings", "gaps", "artifact_id"],
    type: "object",
  },
});
