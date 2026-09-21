import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Investigate the request.",
  model: "openai/gpt-5.6-sol",
});
