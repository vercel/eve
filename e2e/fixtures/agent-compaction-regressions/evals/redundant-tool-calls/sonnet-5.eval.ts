import { defineEval } from "eve/evals";

import { testRedundantToolCalls } from "../shared";

export default defineEval({
  description: "Claude Sonnet 5 does not repeat an identical successful call after compaction.",
  async test(t) {
    await testRedundantToolCalls(t, "sonnet-5");
  },
});
