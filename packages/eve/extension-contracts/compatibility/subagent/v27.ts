import { defineAgent } from "#public/index.js";

// Epoch 27 `session.waiting`, `session.failed`, and `session.completed` events had no `usage`; epoch 28 adds it as optional.
export default defineAgent({
  description: "Research the incidents behind a metric change.",
  model: "openai/gpt-5.6-sol",
});
