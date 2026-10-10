import { defineEval } from "eve/evals";

import { firstSettlementOf, heldTurn, reportIdOf, settlementsOf, taskStarts } from "./task-events";

/**
 * Alice says there's no rush, so the model confirms the report is underway
 * instead of waiting on it. The turn rule still holds the turn: after the
 * reply the turn parks with `turn.waiting`, and the result arrives in the same
 * turn. The confirmation doesn't guess a report id, and the reply after the
 * result reports the real one.
 */
export default defineEval({
  description: "The model doesn't wait on a task when told there's no rush.",
  tags: ["real-model"],
  async test(t) {
    const turn = await t.send(
      "Please start compiling the latency report for Alice. There's no rush, since she'll read it tomorrow, so don't wait on it; just confirm it's underway.",
    );
    turn.expectOk();

    turn.notCalledTool("eve__task_wait");
    turn.eventsSatisfy("eve holds the turn after the reply", heldTurn);
    turn.eventsSatisfy("the model replies before the report is ready", (events) => {
      const callIds = taskStarts(events, "compile_report").map((call) => call.callId);
      const settled = firstSettlementOf(events, callIds);
      const replied = events.findIndex(
        (event) => event.type === "message.completed" && event.data.finishReason === "stop",
      );
      return callIds.length === 1 && replied >= 0 && replied < settled;
    });
    turn.eventsSatisfy("the confirmation doesn't guess a report id", (events) => {
      const confirmation = events.find(
        (event) => event.type === "message.completed" && event.data.finishReason === "stop",
      );
      return confirmation?.type === "message.completed" && !/RPT-/u.test(confirmation.data.message);
    });
    turn.event("task.settled", { count: 1, data: { status: "completed" } });
    turn.eventsSatisfy("the reply after the result reports the report id", (events) => {
      const callIds = taskStarts(events, "compile_report").map((call) => call.callId);
      const reportId = settlementsOf(events, callIds).flatMap(
        (settled) => reportIdOf(settled) ?? [],
      )[0];
      return reportId !== undefined && (turn.message ?? "").includes(reportId);
    });
    t.noFailedActions();
  },
});
