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
        "task.parent.wake.noop-pending-cohort",
      ],
      dimensions: { transport: "local", parentPhase: "parked" },
    },
    async test(t) {
      const children = await startBlockedFanout(t, FANOUT_SIZE);

      // Child streams, not parent replies, acknowledge each release batch.
      for (const count of batches) await children.completeNext(count);
      await t.require(children.completedChildren.length, equals(FANOUT_SIZE - 1));

      const question = await children.send("TASK-BATCHING-QUESTION");
      const intermediate = completionMetrics(children.completionTurns);
      t.check(intermediate.modelSteps, equals(0)).label("no intermediate completion model steps");
      t.check(completionMetrics(children.parentTurns).modelSteps, equals(1)).label(
        "only the independent user question invokes the parent before settlement",
      );
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
      t.check(
        total,
        equals({
          parentTurns: 1,
          modelSteps: 1,
          silentMessages: 0,
          visibleMessages: 1,
          completionsPerTurn: [FANOUT_SIZE],
        }),
      ).label("one full-cohort model turn and visible report");
      t.log(
        `task-batching ${JSON.stringify({ schedule, children: FANOUT_SIZE, intermediate, total })}`,
      );
      t.notEvent("compaction.requested");
      t.noFailedActions();
    },
  }),
);
