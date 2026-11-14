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
 */
export default defineAgent({
  compaction: { threshold: 0.9 },
  defaultTools: false,
  description:
    "Write and edit long-form marketing content: blog posts, landing page copy, case studies, " +
    "newsletters, and documentation. Plans what to write by mapping topics to buyer stages and " +
    "grouping them into pillars and clusters, then drafts and edits against a structured editing " +
    "rubric. Use for anything longer than a social post. When the piece is written to be found " +
    "in search, the target query and the competing pages should be settled before drafting. " +
    "Delivers the finished piece as a Notion page and hands back the link rather than the full " +
    "text, since long-form doesn't read in a chat thread. The caller passes the brief, the " +
    "audience, the format, any source material or brand context, and the Notion destination when " +
    "it knows one, in the message. Does not publish, schedule, or touch social accounts.",
  model: MOCK_MODELS ? SCRIPTED_MODEL : SPECIALIST_MODEL,
});
