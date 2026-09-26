import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { firstRequestOf, HELD_TURN, reportIdOf, settlementsOf, taskStarts } from "./task-events";

/**
 * Two independent reports: the model starts both before it waits, then waits
 * for every result before it answers, without replying in between.
 */
export default defineEval({
  description: "The model fans out independent tasks, then waits for every result.",
  tags: ["real-model"],
  async test(t) {
    const turn = await t.send(
      "Alice needs the churn report and the latency report for Monday's review. Please compile both and give me each report id with its headline.",
    );
    turn.expectOk();

    const started = taskStarts(turn.events, "compile_report");
    t.check(started.length, equals(2)).label("each report is compiled once");
    turn.eventsSatisfy("both reports start before the first wait", (events) => {
      const firstWait = firstRequestOf(events, "task_wait");
      const starts = events.flatMap((event, index) =>
        event.type === "task.started" && event.data.name === "compile_report" ? [index] : [],
      );
      return starts.length === 2 && (firstWait === -1 || Math.max(...starts) < firstWait);
    });
    turn.eventsSatisfy("the reply names every report id", (events) => {
      const settled = settlementsOf(
        events,
        started.map((call) => call.callId),
      );
      const reportIds = settled.flatMap((settlement) => reportIdOf(settlement) ?? []);
      const reply = turn.message ?? "";
      return reportIds.length === 2 && reportIds.every((reportId) => reply.includes(reportId));
    });
    turn.notEvent("session.waiting", { data: HELD_TURN });
    t.noFailedActions();
  },
});
