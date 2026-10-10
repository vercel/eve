import { defineAgent } from "#public/index.js";

// Epoch 33 callbacks that do not inspect a replacement predecessor remain supported.
export default defineAgent({
  description: "Research the incidents behind a metric change.",
  model: "openai/gpt-5.6-sol",
  tool: "deferred",
});
