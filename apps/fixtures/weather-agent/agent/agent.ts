import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.5",
  modelOptions: {
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
      },
    },
  },
});
