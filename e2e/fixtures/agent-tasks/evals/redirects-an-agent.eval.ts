import { defineEval } from "eve/evals";

import { APAC_CHURN } from "../findings";
import { taskStarts } from "./task-events";

/**
 * While the researcher looks into EMEA, Alice corrects the region. The model
 * either corrects the running task by calling the researcher again with its
 * taskId, or stops it with task_cancel and asks again; either way the answer
 * is about APAC.
 */
export default defineEval({
  description: "The model corrects an agent by taskId, or cancels it, after a redirect.",
  tags: ["real-model"],
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      "Please ask the researcher how churn looked in EMEA for Q3 and report back.",
    );
    const first = await live.waitForEvent("task.started", { data: { name: "researcher" } });

    const correction = await live.session.start(
      "Alice made a mistake: she meant APAC, not EMEA. Please get the Q3 churn for APAC instead.",
      { turnPolicy: "steer" },
    );
    const turn = await live.result();
    await correction.result();
    turn.expectOk();

    turn.eventsSatisfy(
      "the first researcher task is corrected by taskId or cancelled",
      (events) => {
        const corrected = taskStarts(events, "researcher").some(
          (call) => call.taskId === first.data.taskId && call.callId !== first.data.callId,
        );
        const cancelled = turn.toolCalls.some(
          (call) => call.name === "task_cancel" && call.input.taskId === first.data.taskId,
        );
        return corrected || cancelled;
      },
    );
    turn.messageIncludes(APAC_CHURN.findingId);
    t.noFailedActions();
  },
});
