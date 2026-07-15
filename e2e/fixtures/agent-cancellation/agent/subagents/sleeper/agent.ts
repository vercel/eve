import { defineAgent } from "eve";

export default defineAgent({
  description: "Waits until its delegated turn is cancelled.",
  model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
});
