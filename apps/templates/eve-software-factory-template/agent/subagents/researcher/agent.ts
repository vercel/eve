import { defineAgent } from "eve";
import { MODELS } from "../../lib/models.js";

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
 * `description` is what the root reads to decide when to delegate; the `run_researcher` tool
 * attaches the output schema that makes the findings a structured, cited result.
 *
 * @see The research methodology and output contract in this folder's `instructions.md`.
 *
 * `tool: false` hides the station from the orchestrator; it calls it through
 * the `run_researcher` workflow tool, which attaches the output schema.
 * The wrapper cannot share this name: the compiler rejects a tool and a local
 * subagent with the same public name, even with `tool: false`.
 */
export default defineAgent({
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links the " +
    "caller doesn't already have. Runs refined searches against reliable sources and returns " +
    "cited findings with confidence levels, plus the gaps it couldn't verify. May save a " +
    "long research memo as an artifact and return its id for later stations. The caller " +
    "passes the question and any known context in the message.",
  model: MODELS.researcher,
  tool: false,
});
