import { e2eModel } from "@eve-e2e/config";
import { equals, satisfies } from "eve/evals/expect";

import { COHORT_SCENARIO } from "../agent/lib/cohort.js";
import { completedTaskIds, completionMetrics, startBlockedFanout } from "./batching.js";
import { defineTaskEval } from "./task-transition.js";

const TASK_COUNT = 3;
const QUESTION =
  "Bob is packing seven boxes with eight jars each. How many jars is that? Reply with just the number.";

export default defineTaskEval({
  description:
    "A real parent model launches a cohort, answers Alice while Bob's last task is blocked, and receives all successful results in one model turn.",
  tags: ["real-model"],
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
    const selectedModel = e2eModel();
    await t.require(typeof selectedModel, equals("string"));
    const cohort = await startBlockedFanout(
      t,
      TASK_COUNT,
      `${COHORT_SCENARIO} Please delegate three independent inventory checks to fanout-worker now, one call per check, before replying. Give each worker its identifier: FANOUT-WORKER-1, FANOUT-WORKER-2, or FANOUT-WORKER-3. Each worker will ask Alice to approve its release. Acknowledge that you started the checks. When their results arrive, give Bob one short report containing each worker's full result identifier exactly once.`,
    );
    await t.require(
      cohort.started.message,
      satisfies(
        (message) =>
          typeof message === "string" &&
          message.trim().length > 0 &&
          !message.includes("FANOUT-COMPLETE:"),
        "the live model acknowledges its background task launches",
      ),
    );
    cohort.started.eventsSatisfy(
      "every launch step uses the real CI model",
      (events) =>
        events.some((event) => event.type === "step.started") &&
        events.every(
          (event) => event.type !== "step.started" || event.data.modelId === selectedModel,
        ),
    );

    // Observe each child's actual completed turn before releasing the next one.
    // The last approval stays pending across an independent parent user turn.
    await cohort.completeNext(1);
    await cohort.completeNext(1);
    await t.require(cohort.completedChildren.length, equals(TASK_COUNT - 1));
    const question = await cohort.send(QUESTION);
    await t.require(question.message?.trim(), equals("56"));
    question.usedNoTools();
    question.event("step.started", {
      count: 1,
      data: (data) => data.modelId === selectedModel,
    });
    t.check(completionMetrics(cohort.parentTurns).modelSteps, equals(1)).label(
      "only the user's question invokes the parent model while the cohort is incomplete",
    );
    t.check(cohort.parentTurns.flatMap(completedTaskIds), equals([])).label(
      "no partial completion notification reaches a parent turn, even alongside user input",
    );

    await cohort.completeNext(1);
    const report = cohort.completionTurns[0];
    if (report === undefined) throw new Error("The cohort has no parent report.");
    report.usedNoTools();
    report.event("step.started", {
      count: 1,
      data: (data) => data.modelId === selectedModel,
    });
    t.check(
      completionMetrics(cohort.completionTurns),
      equals({
        parentTurns: 1,
        modelSteps: 1,
        silentMessages: 0,
        visibleMessages: 1,
        completionsPerTurn: [TASK_COUNT],
      }),
    ).label("the runtime admits one complete cohort, not intermediate silent model turns");
    t.check(completionMetrics(cohort.parentTurns).modelSteps, equals(2)).label(
      "exactly the user answer and the cohort report run after setup",
    );
    t.check(
      cohort.parentTurns.flatMap(completedTaskIds).sort(),
      equals([...cohort.taskIds].sort()),
    ).label("each of the three known tasks is delivered once, with no duplicate or unknown ids");
    t.check(
      report.message?.match(/FANOUT-COMPLETE:FANOUT-WORKER-\d+/gu)?.sort(),
      equals(
        Array.from(
          { length: TASK_COUNT },
          (_, index) => `FANOUT-COMPLETE:FANOUT-WORKER-${index + 1}`,
        ).sort(),
      ),
    ).label("the real model reports all three distinct child outputs exactly once");
    await t.require(cohort.completedChildren.length, equals(TASK_COUNT));
    t.calledSubagent("fanout-worker", { count: TASK_COUNT });
    t.notCalledTool("task_peek");
    t.notEvent("compaction.requested");
    t.noFailedActions();
  },
});
