import { defineAgent } from "#public/index.js";

// Epoch 32 skill loads named their skill only in the action's `input`, and a
// `load-skill-result` might omit `name`; epoch 33 adds `name` to `load-skill`
// requests and requires it on results.
export default defineAgent({
  description: "Research the incidents behind a metric change.",
  model: "openai/gpt-5.6-sol",
  tool: "deferred",
});
