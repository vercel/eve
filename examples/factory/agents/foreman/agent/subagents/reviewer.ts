// PROPOSED API — see research/local-agents.md. `defineLocalAgent` does not
// exist yet; this file illustrates the authoring experience.
import { defineLocalAgent } from "eve";
import reviewer from "#agents/reviewer/agent/agent.ts";

/**
 * References the reviewer agent from this workspace. The reviewer is a
 * complete top-level agent (own instructions, own tools) that can also be
 * developed, evaled, and deployed standalone. When the factory later splits
 * the reviewer into its own deployment, this file becomes a
 * `defineRemoteAgent` mount and Foreman's delegation behavior is unchanged.
 */
export default defineLocalAgent(reviewer, {
  description:
    "Reviews a pull request for correctness and risk. Call this after classification for any unit of work that carries a diff.",
});
