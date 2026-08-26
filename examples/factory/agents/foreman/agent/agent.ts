import { defineAgent } from "eve";

/**
 * Foreman is the factory's orchestrator. It owns no task expertise of its
 * own: it classifies incoming work by delegating to the task agents mounted
 * under `subagents/`, each of which is a complete top-level agent living
 * elsewhere in this workspace.
 */
export default defineAgent({
  model: "anthropic/claude-opus-4.6",
});
