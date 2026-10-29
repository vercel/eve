import { defineAgent } from "eve";

export default defineAgent({
  description: "Answers questions from the data warehouse.",
  model: "anthropic/claude-sonnet-5",
  tool: false, // hidden from the parent model; only workflow tools can call it
});
