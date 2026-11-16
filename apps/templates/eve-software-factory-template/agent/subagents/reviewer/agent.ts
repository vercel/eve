import { defineAgent } from "eve";
import { MODELS } from "../../lib/models.js";

/**
 * Station 4: independent review.
 *
 * @remarks
 * Runs on a different model vendor than the implementer on purpose: fresh
 * eyes are the station's point, and a different model doesn't share the
 * implementer's idiom or blind spots. It fetches the pushed branch into its
 * own checkout and judges the real diff against the analyst's acceptance
 * criteria; it never modifies code. Its verdict routes the pipeline: approve
 * ships a draft PR, request_changes loops back to the implementer (at most
 * twice), reject stops the line.
 *
 * `tool: false` hides the station from the orchestrator; it calls it through
 * the `run_reviewer` workflow tool, which attaches the output schema.
 * The wrapper cannot share this name: the compiler rejects a tool and a local
 * subagent with the same public name, even with `tool: false`.
 */
export default defineAgent({
  description:
    "Independently review a pushed factory branch against the original work item and its " +
    "acceptance criteria: fetch the branch, read the real diff, re-run cheap checks, and " +
    "return approve, request_changes, or reject with specific findings. Never modifies " +
    "code. The caller passes the work item, the analysis with acceptance criteria, the " +
    "branch name, and the implementer's report in the message, plus an artifact id when " +
    "the analyst saved its full detail as one.",
  model: MODELS.reviewer,
  tool: false,
});
