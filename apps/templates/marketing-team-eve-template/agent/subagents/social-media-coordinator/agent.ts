import { defineAgent } from "eve";
import { MOCK_MODELS, SCRIPTED_MODEL } from "#lib/mock-model/config.js";
import { SPECIALIST_MODEL } from "#lib/models/config.js";

/**
 * Subagent runtime configuration.
 *
 * @remarks
 * Sets the description the parent routes on and the model. The rest of the agent's surface
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
    "Run social media work end to end for X, LinkedIn, Threads, Bluesky, and Mastodon: draft " +
    "posts and threads in each platform's voice, adapt one piece across platforms, and manage " +
    "the Typefully queue (read, create, and edit drafts, schedule on request, pull post and " +
    "follower analytics). Researches facts and reviews its own drafts before handing them back. " +
    "The caller passes the brief or source material, the target platforms, and any angle, " +
    "audience, or timing constraints in the message.",
  model: MOCK_MODELS ? SCRIPTED_MODEL : SPECIALIST_MODEL,
});
