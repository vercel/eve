import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Extension specialist that runs the fixed E2E forecast with its mounted toolkit extension.",
  model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
  reasoning: "high",
});
