import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
  reasoning: "high",
});
