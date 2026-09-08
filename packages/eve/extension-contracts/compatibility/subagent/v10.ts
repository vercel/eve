import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Read report data.",
  model: "anthropic/claude-sonnet-5",
});
