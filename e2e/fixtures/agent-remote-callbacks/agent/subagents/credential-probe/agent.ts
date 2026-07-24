import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Acquire the nested probe credential. Send a message asking it to acquire the credential.",
  model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
  reasoning: "high",
});
