import { defineAgent } from "#public/index.js";

// Epoch 26 `task.settled` events had no `cancel`; epoch 27 adds it as optional.
export default defineAgent({
  description: "Research the incidents behind a metric change.",
  model: "openai/gpt-5.6-sol",
});
