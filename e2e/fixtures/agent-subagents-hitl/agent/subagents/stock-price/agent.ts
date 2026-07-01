import { defineAgent } from "eve";
import { DEFAULT_EVAL_MODEL } from "eve/evals";

export default defineAgent({
  description:
    'Look up the current stock price for a given ticker symbol. Pass the ticker symbol you want to look up in the message (e.g. "AAPL", "GOOG", or "TSLA").',
  model: DEFAULT_EVAL_MODEL,
  reasoning: "high",
});
