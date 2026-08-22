import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.6-luna",
  modelOptions: {
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
      },
    },
  },
});
