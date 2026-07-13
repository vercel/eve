import { defineEval } from "eve/evals";

import { testRedundantToolCalls } from "../shared";

export default defineEval({
  description: "Claude Opus 4.8 does not repeat an identical successful call after compaction.",
  async test(t) {
    await testRedundantToolCalls(t, "opus-4.8");
  },
});
