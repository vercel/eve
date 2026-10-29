import { defineAgent } from "eve";

export default defineAgent({
  description: "Researches a question in the team's Notion and returns a sourced answer.",
  model: "anthropic/claude-sonnet-5",
});
