import { defineEval } from "eve/evals";

import { continueKeeperAcrossTurns } from "./agent-continuation.shared";

/** Deterministic local continuation before cancel and fresh delegation afterward. */
export default defineEval({
  description:
    "A local keeper remembers across idle turns; cancellation ends its task and child, and a new keeper learns Alice's name again.",
  timeoutMs: 120_000,
  async test(t) {
    await continueKeeperAcrossTurns(t, "notebook-keeper");
    t.noFailedCalls();
  },
});
