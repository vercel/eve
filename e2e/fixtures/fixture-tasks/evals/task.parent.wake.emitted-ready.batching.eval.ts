import { equals } from "eve/evals/expect";

import { completedTaskIds, completionMetrics, startBlockedFanout } from "./batching.js";
import { defineTaskEval } from "./task-transition.js";

const FANOUT_SIZE = 10;
const EXPECTED_REPORT = JSON.stringify({
  report: "TASK-BATCHING-REPORT",
  results: Array.from(
    { length: FANOUT_SIZE },
    (_, index) => `FANOUT-COMPLETE:FANOUT-WORKER-${index + 1}`,
  ).sort(),
});

export default [
  { schedule: "burst", batches: [9] },
  { schedule: "staggered", batches: [1, 1, 1, 1, 1, 1, 1, 1, 1] },
].map(({ schedule, batches }) =>
  defineTaskEval({
    description: `Measure completion-driven parent model steps for ${FANOUT_SIZE} children (${schedule}).`,
    timeoutMs: 180_000,
    transition: {
      primary: "task.parent.wake.emitted-ready",
      setup: [
        "task.dispatch.start.accepted-acknowledged",
        "task.input.require.accepted-valid-batch",
        "task.input.answer.accepted-complete",
        "task.lifecycle.complete.accepted-nonterminal",
      ],
      dimensions: { transport: "local", parentPhase: "parked" },
    },
    async test(t) {
      const children = await startBlockedFanout(t, FANOUT_SIZE);

      // Complete nine children, keeping the last child blocked.
      // Each batch waits for the parent response before releasing the next.
      for (const count of batches) await children.completeNext(count);
      const intermediate = completionMetrics(children.completionTurns);
      t.check(intermediate.visibleMessages, equals(0)).label("intermediate completions are silent");

      const question = await children.send("TASK-BATCHING-QUESTION");
      t.check(question.message, equals("56")).label(
        "user question answered while a child is blocked",
      );
      question.usedNoTools();

      await children.completeNext(1);
      t.check(
        children.completionTurns.flatMap(completedTaskIds).sort(),
        equals([...children.taskIds].sort()),
      ).label("every child result delivered exactly once, with no unknown task ids");
      t.check(children.completionTurns.at(-1)?.message, equals(EXPECTED_REPORT)).label(
        "final report contains every distinct child result exactly once",
      );

      const total = completionMetrics(children.completionTurns);
      t.check(total.visibleMessages, equals(1)).label("one visible final report");
      t.log(
        `task-batching ${JSON.stringify({ schedule, children: FANOUT_SIZE, intermediate, total })}`,
      );
      t.notEvent("compaction.requested");
      t.noFailedActions();
    },
  }),
);
