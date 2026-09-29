import { defineEval } from "eve/evals";

import { continueKeeperAcrossTurns } from "./agent-continuation.shared";

/**
 * Deterministic counterpart of `agent-messaging-remote`: the keeper is this
 * deployment's root agent reached over HTTP, and the cancel travels the
 * remote protocol.
 */
export default defineEval({
  description:
    "A remote agent task is continued by taskId across turns and after task_cancel with its conversation intact.",
  timeoutMs: 120_000,
  async test(t) {
    await continueKeeperAcrossTurns(t, "remote-loopback");
    t.noFailedActions();
  },
});
