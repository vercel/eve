import { defineEval } from "eve/evals";

import { testStaleTodoWork } from "../shared";

export default defineEval({
  description: "Claude Opus 4.8 does not repeat completed work because a todo stayed pending.",
  async test(t) {
    await testStaleTodoWork(t, "opus-4.8");
  },
});
