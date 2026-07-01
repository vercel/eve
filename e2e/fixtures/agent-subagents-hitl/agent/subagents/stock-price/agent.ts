import { defineAgent } from "eve";

export default defineAgent({
  description:
    'Look up the current stock price for a given ticker symbol. Pass the ticker symbol you want to look up in the message (e.g. "AAPL", "GOOG", or "TSLA").',
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
});
