import { defineAgent } from "eve";
import { MODELS } from "#lib/models.js";

/**
 * Station 3: implementation.
 *
 * @remarks
 * Executes the analyst's plan in its own checkout of the factory repository,
 * verifies the work with the repository's own checks, commits on a feature
 * branch, and pushes it with the `push_branch` tool. The push is the
 * station's only side effect and it is inert by construction: feature
 * branches only (main and master are refused in code), the credential is
 * brokered at the sandbox firewall, and a branch alone can't merge. The pull
 * request is opened later by the orchestrator, after review.
 */
export default defineAgent({
  description:
    "Execute an approved implementation plan in a checkout of the factory repository: " +
    "write the code on a feature branch, run the repository's own checks, commit, and " +
    "push the branch. Returns the branch name, per-file change summary, verification " +
    "results, and deviations. The caller passes the work item, classification, and full " +
    "analysis in the message, plus an artifact id when the analyst saved its full detail " +
    "as one; on a revision run it also passes the existing branch and the reviewer's " +
    "findings.",
  model: MODELS.implementer,
  outputSchema: {
    additionalProperties: false,
    properties: {
      base: {
        description: "The branch the work is based on, normally the repository's default branch.",
        type: "string",
      },
      branch: {
        description: "The feature branch the work was committed and pushed to.",
        type: "string",
      },
      change_summary: {
        description: "What changed and why, per file.",
        items: {
          additionalProperties: false,
          properties: {
            change: {
              description: "What changed in this file and why.",
              type: "string",
            },
            path: { description: "The file path.", type: "string" },
          },
          required: ["path", "change"],
          type: "object",
        },
        type: "array",
      },
      deviations: {
        description: "Departures from the plan, each with its reason; empty when the plan held.",
        items: { type: "string" },
        type: "array",
      },
      known_limitations: {
        description: "Anything the reviewer should scrutinize.",
        items: { type: "string" },
        type: "array",
      },
      pushed: {
        description:
          "Whether push_branch succeeded; when false, the failure reason is in known_limitations.",
        type: "boolean",
      },
      verification: {
        description: "Commands run and what they produced, exactly.",
        items: {
          additionalProperties: false,
          properties: {
            command: { description: "The command as run.", type: "string" },
            result: {
              description: "What it produced: pass/fail and the relevant output.",
              type: "string",
            },
          },
          required: ["command", "result"],
          type: "object",
        },
        type: "array",
      },
    },
    required: [
      "branch",
      "base",
      "pushed",
      "change_summary",
      "verification",
      "deviations",
      "known_limitations",
    ],
    type: "object",
  },
});
