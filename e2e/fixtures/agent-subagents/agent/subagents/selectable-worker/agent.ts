import { defineAgent } from "eve";

export default defineAgent({
  description: "Keep a short note for Alice and answer follow-up questions about that note.",
  model: "openai/gpt-5.5",
  delegationModels: ["openai/gpt-5.5"],
  limits: { maxTokenCostUsdPerSession: 1 },
});
