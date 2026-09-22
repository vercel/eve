import { defineAgent } from "#public/index.js";

/**
 * Epoch 11 predates `experimental.workflow.retention`, so a subagent authored
 * against it never sets the field. It must keep compiling now that the field
 * exists.
 */
export default defineAgent({
  description: "Delegate research tasks.",
  experimental: {
    workflow: {
      modelCallsPerStep: 4,
    },
  },
  model: "anthropic/claude-sonnet-5",
});
