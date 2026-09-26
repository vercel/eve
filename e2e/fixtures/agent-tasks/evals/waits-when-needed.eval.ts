import { defineEval } from "eve/evals";

import { EMEA_CHURN } from "../findings";
import { HELD_TURN } from "./task-events";

/**
 * The answer depends on the researcher's result, so the model waits for it
 * with `task_wait` instead of ending its step while the task works.
 */
export default defineEval({
  description: "The model waits for an agent's result when its answer depends on it.",
  tags: ["real-model"],
  async test(t) {
    const turn = await t.send(
      "Bob asked Alice how churn looked in EMEA for Q3. Please ask the researcher and tell me what it found, so Alice can pass it on to Bob.",
    );
    turn.expectOk();

    t.calledSubagent("researcher", { status: "completed" });
    turn.calledTool("task_wait");
    turn.notEvent("session.waiting", { data: HELD_TURN });
    turn.messageIncludes(EMEA_CHURN.findingId);
    t.noFailedActions();
  },
});
