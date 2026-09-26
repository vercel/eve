import { defineEval } from "eve/evals";

import { continueKeeperAcrossTurns } from "./agent-continuation.shared";

/** Deterministic counterpart of `agent-messaging-local`, with a cancel between the turns. */
export default defineEval({
  description:
    "A local agent task is continued by taskId across turns and after task_cancel with its conversation intact.",
  timeoutMs: 120_000,
  async test(t) {
    await continueKeeperAcrossTurns(t, "notebook-keeper");
    t.noFailedActions();
  },
});
