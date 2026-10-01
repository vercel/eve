import { defineAgent } from "#public/index.js";

// Epoch 27 `turn.waiting` events had no `awaitingPerson`; epoch 28 adds it as optional.
export default defineAgent({
  description: "Research the incidents behind a metric change.",
  model: "openai/gpt-5.6-sol",
});
