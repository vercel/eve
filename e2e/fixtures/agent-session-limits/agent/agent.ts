import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
  // A one-token input budget guarantees every completed model call crosses
  // the limit, so the next conversation turn deterministically parks on the
  // session-limit continuation prompt.
  limits: {
    maxInputTokensPerSession: 1,
  },
});
