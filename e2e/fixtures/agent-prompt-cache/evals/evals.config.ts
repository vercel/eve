import { defineEvalConfig } from "eve/evals";

/** Judge is unused here; assertions are numeric. Kept for config parity. */
export default defineEvalConfig({
  judge: { model: "openai/gpt-5.5" },
});
