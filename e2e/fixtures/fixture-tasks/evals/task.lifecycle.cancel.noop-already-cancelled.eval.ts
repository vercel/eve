import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  sendAndFollowQueuedTurn,
  waitForTaskInput,
  waitForTaskStatus,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

/** Repeating cancellation preserves the existing cancelled task view. */
export default defineTaskEval({
  description: "task_cancel is a no-op when the task is already cancelled.",
  transition: {
    primary: "task.lifecycle.cancel.noop-already-cancelled",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.input.require.accepted-valid-batch",
      "task.lifecycle.cancel.accepted-nonterminal",
    ],
    dimensions: { transport: "local", parentPhase: "active" },
  },
  async test(t) {
    const started = await t.send("TASK-CANCEL-SETUP");
    started.expectOk();
    started.messageIncludes("TASK-CANCEL-READY");
    started.event("subagent.completed", {
      count: 1,
      data: { backgroundTask: { status: "working" }, subagentName: "fanout-worker" },
    });
    const taskId = requireBackgroundTaskId(started);

    const blocked = await waitForTaskInput(t, t, "release");
    const cancelled = await sendAndFollowQueuedTurn(t, "TASK-CANCEL-NOW", blocked.session);
    cancelled.turn.expectOk();
    cancelled.turn.calledTool("task_cancel", { input: { taskIds: [taskId] } });
    const cancelledCall = cancelled.turn.toolCalls.find((call) => call.name === "task_cancel");
    const cancelledView = requireTaskView(cancelledCall?.output, taskId);

    const repeated = await sendAndFollowQueuedTurn(t, "TASK-CANCEL-NOW", cancelled.session);
    repeated.turn.expectOk();
    repeated.turn.messageIncludes("TASK-CANCEL-DONE");
    repeated.turn.calledTool("task_cancel", { input: { taskIds: [taskId] } });
    const repeatedCall = repeated.turn.toolCalls.find((call) => call.name === "task_cancel");
    await t.require(
      requireTaskView(repeatedCall?.output, taskId),
      satisfies(
        (view: Record<string, unknown>) => hasSameCancelledFields(view, cancelledView),
        "repeated cancellation preserves every model-visible cancelled-task field",
      ),
    );

    const still = await waitForTaskStatus(
      t,
      repeated.session,
      "TASK-CANCEL-VERIFY",
      taskId,
      "cancelled",
    );
    still.expectOk();
    await t.require(
      requireTaskView(still.requireToolCall("task_peek").output, taskId),
      satisfies(
        (view: Record<string, unknown>) => hasSameCancelledFields(view, cancelledView),
        "task_peek observes the same semantic fields after repeated cancellation",
      ),
    );
  },
});

function hasSameCancelledFields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const actualMetadata = Reflect.get(actual, "metadata");
  const expectedMetadata = Reflect.get(expected, "metadata");
  return (
    Reflect.get(actual, "taskId") === Reflect.get(expected, "taskId") &&
    Reflect.get(actual, "status") === "cancelled" &&
    Reflect.get(expected, "status") === "cancelled" &&
    !Object.hasOwn(actual, "inputRequests") &&
    !Object.hasOwn(actual, "lastOutput") &&
    !Object.hasOwn(expected, "inputRequests") &&
    !Object.hasOwn(expected, "lastOutput") &&
    actualMetadata !== null &&
    typeof actualMetadata === "object" &&
    expectedMetadata !== null &&
    typeof expectedMetadata === "object" &&
    Reflect.get(actualMetadata, "agentId") === Reflect.get(expectedMetadata, "agentId") &&
    Reflect.get(actualMetadata, "kind") === Reflect.get(expectedMetadata, "kind") &&
    Reflect.get(actualMetadata, "mode") === Reflect.get(expectedMetadata, "mode") &&
    Reflect.get(actualMetadata, "name") === Reflect.get(expectedMetadata, "name")
  );
}
