import { defineAgent } from "eve";
import { DEFAULT_EVAL_MODEL } from "eve/evals";

export default defineAgent({
  model: DEFAULT_EVAL_MODEL,
  reasoning: "high",
});
