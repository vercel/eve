import { defineAgent } from "eve";

/**
 * A task agent in the factory: reviews pull requests. Owns its own tools
 * (`tools/read_diff.ts`) and instructions. Deployed standalone it could
 * also declare `channels/` (e.g. a GitHub webhook aimed directly at the
 * reviewer); channels stay inert when this agent runs as a delegate
 * inside Foreman's deployment.
 */
export default defineAgent({
  model: "anthropic/claude-opus-4.6",
  reasoning: "high",
});
