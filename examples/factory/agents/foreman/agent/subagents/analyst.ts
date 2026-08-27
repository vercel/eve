// PROPOSED API — see research/local-agents.md. `defineLocalAgent` does not
// exist yet; this file illustrates the authoring experience.
import { defineLocalAgent } from "eve";
import analyst from "#agents/analyst/agent/agent.ts";

/**
 * Mounts the analyst station from this workspace. The import is the address:
 * config, instructions, tools, and sandbox come from `agents/analyst/`,
 * compiled once for this deployment. The station's own `description` and
 * `outputSchema` (authored in its agent.ts) carry over; pass an override
 * here only to reframe the delegation in Foreman's terms.
 */
export default defineLocalAgent(analyst);
