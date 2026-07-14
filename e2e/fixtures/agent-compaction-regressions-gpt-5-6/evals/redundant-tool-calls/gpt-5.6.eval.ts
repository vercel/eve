import { defineEval } from "eve/evals";
import { testRedundantToolCalls } from "@eve/e2e-compaction-regression-shared/evals";

export default defineEval({
  description: "GPT-5.6 does not repeat an identical successful call after compaction.",
  async test(t) {
    await testRedundantToolCalls(t, "gpt-5.6");
  },
});
