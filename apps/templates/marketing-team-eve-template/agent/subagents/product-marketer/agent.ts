import { defineAgent } from "eve";
import { MOCK_MODELS, SCRIPTED_MODEL } from "#lib/mock-model/config.js";
import { SPECIALIST_MODEL } from "#lib/models/config.js";

/**
 * Subagent runtime configuration.
 *
 * @remarks
 * Sets the description the root routes on and the model. The rest of the agent's surface
 * (connections, tools, skills) is discovered from the filesystem. Conversation history is compacted
 * once it reaches 90% of the context window.
 *
 * `defaultTools: false` turns off every optional built-in. The ones this specialist needs
 * (`read_file`, `web_fetch`, `web_search`) are added back by files under `tools/`, so a built-in
 * that a later eve release adds stays off until someone opts in. Under `MOCK_MODELS` the model is a
 * scripted mock for the offline evals.
 *
 * This is the only specialist that treats the brand context document as its deliverable rather than
 * as input, so it carries `save_brand_context` alongside the read tool. That write overwrites the
 * document for the whole team, with no approval gate and no previous version to recover, which is
 * why the interviewing discipline in `instructions.md` matters: agreeing the document with the user
 * before saving is the only review it gets.
 *
 * A positioning document is short by design, and length here is usually a symptom of hedging rather
 * than thoroughness, so the brevity discipline lives in `instructions.md`.
 */
export default defineAgent({
  compaction: { threshold: 0.9 },
  defaultTools: false,
  description:
    "Work out and write down what the product is, who it's for, and why anyone would pick it: " +
    "positioning, the competitive alternatives, the ideal customer, the message hierarchy, value " +
    "propositions per audience, objection handling, and the proof behind each claim. Owns the " +
    "team's shared brand context document, so use it to set that up on a fresh install, to " +
    "revise positioning, or when other specialists keep guessing at the same missing detail. " +
    "Interviews the user and researches the competitive set rather than inventing an answer, and " +
    "writes claims that can be checked. Does not draft posts, pages, or campaigns.",
  model: MOCK_MODELS ? SCRIPTED_MODEL : SPECIALIST_MODEL,
});
