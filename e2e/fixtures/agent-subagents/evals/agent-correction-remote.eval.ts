import { defineEval } from "eve/evals";

import { correctKeeperWhileItWorks } from "./agent-correction.shared";

/** The keeper is this deployment's root agent reached over HTTP, so the correction travels the remote protocol. */
export default defineEval({
  description:
    "A remote agent corrected by taskId while its tool runs answers the correction and settles the parent's call.",
  timeoutMs: 120_000,
  async test(t) {
    await correctKeeperWhileItWorks(t, "remote-loopback");
    t.noFailedActions();
  },
});
