import { defineEval } from "eve/evals";
import { testStaleTodoWork } from "@eve/e2e-compaction-regression-shared/evals";

export default defineEval({
  description: "The model does not redo completed work because a stale todo stayed pending.",
  async test(t) {
    await testStaleTodoWork(t);
  },
});
