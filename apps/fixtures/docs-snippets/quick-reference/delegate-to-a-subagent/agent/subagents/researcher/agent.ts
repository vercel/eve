import { defineAgent } from "eve";

export default defineAgent({
  description: "Researches a question in the issue tracker and returns a sourced answer.",
  model: "anthropic/claude-sonnet-5",
});
