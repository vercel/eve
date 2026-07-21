import { testRedundantToolCalls } from "@eve/e2e-compaction-regression-shared/evals";
import { defineEval } from "eve/evals";

export default defineEval({
  description: "Claude Opus 4.8 does not repeat an identical successful call after compaction.",
  async test(t) {
    await testRedundantToolCalls(t, "opus-4.8");
  },
});
