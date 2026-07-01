import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.EVE_EVAL_MODEL ?? "anthropic/claude-sonnet-5",
  reasoning: "high",
});
