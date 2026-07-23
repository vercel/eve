import { defineEvalConfig } from "eve/evals";

/** Judge is unused here; assertions are numeric. Kept for config parity. */
export default defineEvalConfig({
  judge: { model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol" },
});
