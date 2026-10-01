import { defineAgent } from "#public/index.js";

// Epoch 27 parents had no `task.activity` event for an agent's tool calls; epoch 28 adds it.
export default defineAgent({
  description: "Research the incidents behind a metric change.",
  model: "openai/gpt-5.6-sol",
});
