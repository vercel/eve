import { defineEval } from "eve/evals";

import { testStaleTodoWork } from "../shared";

export default defineEval({
  description: "Claude Sonnet 5 does not repeat completed work because a todo stayed pending.",
  async test(t) {
    await testStaleTodoWork(t, "sonnet-5");
  },
});
