import { defineEval } from "eve/evals";

import {
  requireBackgroundTaskId,
  requireTaskView,
  sendAndFollowQueuedTurn,
  waitForCompletedTask,
  waitForTaskInput,
} from "./shared.js";
import { satisfies } from "eve/evals/expect";

/**
 * Replaying Q1 after the child has raised Q2 must neither deliver Q1 again nor
 * clear Q2 from the task snapshot.
 */
export default defineEval({
  description: "A stale task answer cannot unblock or erase the child's newer approval request.",
  async test(t) {
    const started = await t.send("TASK-INPUT-BATCH-ORDERING");
    started.expectOk();
    const taskId = requireBackgroundTaskId(started);

    const first = await waitForTaskInput(t, t, "first_gate");
    const firstAnswer = await first.session.respond({
      optionId: "approve",
      requestId: first.request.requestId,
    });
    firstAnswer.expectOk();

    const second = await waitForTaskInput(t, first.session, "second_gate");
    const stale = await second.session.respond({
      optionId: "approve",
      requestId: first.request.requestId,
    });
    stale.expectOk();

    const afterStale = await sendAndFollowQueuedTurn(
      t,
      `TASK-INPUT-BATCH-VERIFY ${taskId}`,
      second.session,
    );
    const peeked = afterStale.turn.toolCalls.find((call) => call.name === "task_peek");
    await t.require(
      peeked?.output,
      satisfies((output) => {
        const view = requireTaskView(output, taskId);
        const requests = Reflect.get(view, "inputRequests");
        return (
          Reflect.get(view, "status") === "input_required" &&
          Array.isArray(requests) &&
          requests.length === 1 &&
          Reflect.get(requests[0], "requestId") === second.request.requestId
        );
      }, "the stale Q1 answer leaves exactly Q2 outstanding"),
    );

    // If the stale Q1 answer cleared Q2, this exact Q2 response cannot resume
    // the child and the task never reaches `completed`.
    const secondAnswer = await afterStale.session.respond({
      optionId: "approve",
      requestId: second.request.requestId,
    });
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
