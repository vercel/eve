import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.EVE_EVAL_MODEL ?? "anthropic/claude-sonnet-5",
  modelOptions: {
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
      },
    },
  },
});
