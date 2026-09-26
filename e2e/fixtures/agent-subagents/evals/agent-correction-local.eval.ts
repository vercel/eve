import { defineEval } from "eve/evals";

import { correctKeeperWhileItWorks } from "./agent-correction.shared";

export default defineEval({
  description:
    "A local agent corrected by taskId while its tool runs answers the correction and settles the parent's call.",
  timeoutMs: 120_000,
  async test(t) {
    await correctKeeperWhileItWorks(t, "notebook-keeper");
    t.noFailedActions();
  },
});
