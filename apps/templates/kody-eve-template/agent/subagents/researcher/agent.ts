import { defineAgent } from "eve";

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
 * `tool: false` hides the derived subagent tool from the root model. The root reaches this
 * agent through the same-named `researcher` workflow tool (`agent/tools/researcher.ts`), which
 * opens a session with `ctx.agent("researcher")` and requests the structured, cited result per
 * turn: eve no longer accepts `outputSchema` on `defineAgent`.
 *
 * @see The research methodology and output contract in this folder's `instructions.md`.
 */
export default defineAgent({
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links the " +
    "caller doesn't already have. Runs refined searches against reliable sources and returns " +
    "cited findings with confidence levels, plus the gaps it couldn't verify. The caller " +
    "passes the question and any known context in the message.",
  model: "openai/gpt-5.6-terra",
  tool: false,
});
