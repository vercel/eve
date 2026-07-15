import { testStaleTodoWork } from "@eve/e2e-compaction-regression-shared/evals";
import { defineEval } from "eve/evals";

export default defineEval({
  description: "Claude Opus 4.8 does not repeat completed work because a todo stayed pending.",
  async test(t) {
    await testStaleTodoWork(t, "opus-4.8");
  },
});
