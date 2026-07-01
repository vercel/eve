import { defineAgent } from "eve";
import { DEFAULT_EVAL_MODEL } from "eve/evals";

export default defineAgent({
  model: DEFAULT_EVAL_MODEL,
  modelOptions: {
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
      },
    },
  },
});
