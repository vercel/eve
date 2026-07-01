import { defineAgent } from "eve";
import { DEFAULT_EVAL_MODEL } from "eve/evals";

export default defineAgent({
  limits: {
    maxSubagentDepth: 4,
  },
  model: DEFAULT_EVAL_MODEL,
  reasoning: "high",
});
