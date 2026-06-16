import { defineEvalConfig } from "eve/evals";

/** Default judge model for any `t.judge.*` assertion in this fixture. */
export default defineEvalConfig({
  judge: { model: "openai/gpt-5.5" },
});
