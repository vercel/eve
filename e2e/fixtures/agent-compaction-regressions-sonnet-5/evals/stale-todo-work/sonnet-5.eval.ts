import { testStaleTodoWork } from "@eve/e2e-compaction-regression-shared/evals";
import { defineEval } from "eve/evals";

export default defineEval({
  description: "Claude Sonnet 5 does not repeat completed work because a todo stayed pending.",
  async test(t) {
    await testStaleTodoWork(t, "sonnet-5");
  },
});
