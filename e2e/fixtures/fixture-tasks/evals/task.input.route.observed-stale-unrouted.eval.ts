import {
  requireBackgroundTaskId,
  sendAndFollowQueuedTurn,
  waitForCompletedTask,
  waitForTaskInput,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

/**
 * Once Q1's proxy route is retired, replaying its answer becomes new parent
 * input and cannot reach the child or clear Q2 from the task snapshot.
 */
export default defineTaskEval({
  description:
    "An answer for a retired proxy route becomes parent input without unblocking or erasing the child's newer request.",
  transition: {
    primary: "task.input.route.observed-stale-unrouted",
    dimensions: { transport: "local" },
  },
  async test(t) {
    const started = await t.send("TASK-INPUT-BATCH-ORDERING");
    started.expectOk();
    const taskId = requireBackgroundTaskId(started);

    const first = await waitForTaskInput(t, t, "first_gate");
    const firstAnswer = await first.session.respond([
      {
        optionId: "approve",
        requestId: first.request.requestId,
      },
    ]);
    firstAnswer.expectOk();

    const second = await waitForTaskInput(t, first.session, "second_gate");
    const stale = await second.session.respond([
      {
        optionId: "approve",
        requestId: first.request.requestId,
      },
    ]);
    stale.expectOk();
    stale.event("step.started", { count: 1 });
    stale.noFailedActions();

    const afterStale = await sendAndFollowQueuedTurn(
      t,
      `TASK-INPUT-BATCH-VERIFY ${taskId}`,
      second.session,
    );
    afterStale.turn.notCalledTool("task_cancel");

    // This exact Q2 response can only resume the child if the stale Q1 answer
    // left Q2 outstanding. Completion below is the externally observable proof.
    const secondAnswer = await afterStale.session.respond([
      {
        optionId: "approve",
        requestId: second.request.requestId,
      },
    ]);
    secondAnswer.expectOk();

    const verified = await waitForCompletedTask(
      t,
      afterStale.session,
      "TASK-INPUT-BATCH-VERIFY",
      taskId,
    );
    verified.expectOk();
    verified.messageIncludes("TASK-INPUT-BATCH-STATUS");
    t.noFailedActions();
  },
});
