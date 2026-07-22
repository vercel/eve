import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol" },
});
