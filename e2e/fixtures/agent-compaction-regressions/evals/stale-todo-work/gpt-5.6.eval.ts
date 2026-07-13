import { defineEval } from "eve/evals";

import { testStaleTodoWork } from "../shared";

export default defineEval({
  description: "GPT-5.6 does not repeat completed work because a todo stayed pending.",
  async test(t) {
    await testStaleTodoWork(t, "gpt-5.6");
  },
});
