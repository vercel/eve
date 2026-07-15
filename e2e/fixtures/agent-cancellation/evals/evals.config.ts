import { defineEvalConfig } from "eve/evals";

/** Default judge model for any `t.judge.*` assertion in this fixture. */
export default defineEvalConfig({
  judge: { model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol" },
});
