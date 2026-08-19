import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  sendAndFollowQueuedTurn,
  waitForTaskInput,
  waitForTaskStatus,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

/** Cancellation commits `cancelled` while the child is waiting for input. */
export default defineTaskEval({
  description: "task_cancel commits a final cancelled state on a nonterminal task.",
  transition: {
    primary: "task.lifecycle.cancel.accepted-nonterminal",
    setup: ["task.dispatch.start.accepted-acknowledged", "task.input.require.accepted-valid-batch"],
    dimensions: { transport: "local", parentPhase: "active" },
  },
  async test(t) {
    const started = await t.send("TASK-CANCEL-SETUP");
    started.expectOk();
    started.event("subagent.completed", {
      count: 1,
      data: { backgroundTask: { status: "working" }, subagentName: "fanout-worker" },
    });
    const taskId = requireBackgroundTaskId(started);

    const blocked = await waitForTaskInput(t, t, "release");
    const cancelled = await sendAndFollowQueuedTurn(t, "TASK-CANCEL-NOW", blocked.session);
    cancelled.turn.expectOk();
    cancelled.turn.messageIncludes("TASK-CANCEL-DONE");
    cancelled.turn.calledTool("task_cancel", { input: { taskIds: [taskId] } });
    const cancelledCall = cancelled.turn.toolCalls.find((call) => call.name === "task_cancel");
    const cancelledView = requireTaskView(cancelledCall?.output, taskId);
    await t.require(
      cancelledView,
      satisfies(
        (view: Record<string, unknown>) => isCancelledTaskView(view, taskId),
        "the first cancellation returns the cancelled task without output or pending input",
      ),
    );

    const verified = await waitForTaskStatus(
      t,
      cancelled.session,
      "TASK-CANCEL-VERIFY",
      taskId,
      "cancelled",
    );
    verified.expectOk();
    verified.messageIncludes("TASK-CANCEL-STATUS");
    await t.require(
      requireTaskView(verified.requireToolCall("task_cancel").output, taskId),
      satisfies(
        (view: Record<string, unknown>) => hasSameCancelledFields(view, cancelledView),
        "no-op cancellation preserves the cancelled task's semantic fields",
      ),
    );
  },
});

function isCancelledTaskView(view: Record<string, unknown>, taskId: string): boolean {
  return (
    Reflect.get(view, "taskId") === taskId &&
    Reflect.get(view, "status") === "cancelled" &&
    !Object.hasOwn(view, "inputRequests") &&
    !Object.hasOwn(view, "lastOutput")
  );
}

function hasSameCancelledFields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const actualMetadata = Reflect.get(actual, "metadata");
  const expectedMetadata = Reflect.get(expected, "metadata");
  const expectedTaskId = Reflect.get(expected, "taskId");
  return (
    typeof expectedTaskId === "string" &&
    isCancelledTaskView(actual, expectedTaskId) &&
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
