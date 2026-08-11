import { defineAgent } from "eve";

export default defineAgent({
  model: "zai/glm-5.2-fast",
  modelOptions: {
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
      },
    },
  },
});
