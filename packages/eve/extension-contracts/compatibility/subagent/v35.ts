import { defineAgent } from "#public/index.js";

// Epoch 35 reached the v26 stream event types through client results; epoch 36 replaces
// them with v27 session events. Subagents that don't read session events keep working.
export default defineAgent({
  description: "Research the incidents behind a metric change.",
  model: "openai/gpt-5.6-sol",
  tool: "deferred",
});
