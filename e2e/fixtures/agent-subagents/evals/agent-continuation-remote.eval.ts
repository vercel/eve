import { defineEval } from "eve/evals";

import { continueKeeperAcrossTurns } from "./agent-continuation.shared";

/**
 * Deterministic counterpart of `agent-messaging-remote`: the keeper is this
 * deployment's root agent reached over HTTP; cancellation retires that
 * remote child before a new task starts another.
 */
export default defineEval({
  description:
    "A remote keeper remembers across idle turns; cancellation ends its task and child, and a new keeper learns Alice's name again.",
  timeoutMs: 120_000,
  async test(t) {
    await continueKeeperAcrossTurns(t, "remote-loopback");
    t.noFailedCalls();
  },
});
