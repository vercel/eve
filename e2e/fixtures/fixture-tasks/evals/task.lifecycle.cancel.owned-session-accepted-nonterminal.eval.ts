import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  waitForTaskInput,
  sendAndFollowQueuedTurn,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

/** Session cancellation can retire indexed tasks while the parent is parked. */
export default defineTaskEval({
  description: "session.cancel({ tasks: true }) cancels an owned task without ending the session.",
  transition: {
    primary: "task.lifecycle.cancel.owned-session-accepted-nonterminal",
    setup: ["task.dispatch.start.accepted-acknowledged", "task.input.require.accepted-valid-batch"],
    dimensions: { transport: "local", parentPhase: "parked" },
  },
  async test(t) {
    const started = await t.send("TASK-CANCEL-SETUP", { taskDeliveryPolicy: "cohort" });
    started.expectOk();
    const taskId = requireBackgroundTaskId(started);
    const blocked = await waitForTaskInput(t, started.session, "release");
    const sessionId = blocked.session.sessionId;
    if (sessionId === undefined) throw new Error("Task parent has no session id.");

    const response = await t.target.fetch(`/eve/v1/session/${sessionId}/cancel`, {
      body: JSON.stringify({ tasks: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const responseBody: unknown = await response.json();
    await t.require(
      { body: responseBody, status: response.status },
      satisfies(
        (result: { readonly body: unknown; readonly status: number }) =>
          result.status === 202 &&
          result.body !== null &&
          typeof result.body === "object" &&
          Reflect.get(result.body, "status") === "accepted",
        "the parked session accepts owned-task cancellation",
      ),
    );

    // Before task_cancel can affect the outcome, prove session cancellation
    // retired the approval route: its old answer must reach the parent model.
    // If the task were still live, this answer would instead release the child.
    const staleAnswer = await blocked.session.respond([
      { optionId: "approve", requestId: blocked.request.requestId },
    ]);
    staleAnswer.expectOk();
    staleAnswer.event("step.started", { count: 1 });
    staleAnswer.notCalledTool("task_cancel");
    staleAnswer.notEvent("subagent.completed");
    const inspected = await sendAndFollowQueuedTurn(
      t,
      `TASK-CANCEL-INSPECT ${taskId}`,
      staleAnswer.session,
    );
    const verified = inspected.turn;
    for (const turn of [staleAnswer, ...inspected.observedTurns]) {
      turn.notEvent("message.received", {
        data: { message: (message) => message.startsWith("Background task ") },
      });
    }
    verified.expectOk();
    verified.messageIncludes("TASK-CANCEL-STATUS");
    await t.require(
      requireTaskView(verified.requireToolCall("task_cancel").output, taskId),
      satisfies(
        (view: Record<string, unknown>) => Reflect.get(view, "status") === "cancelled",
        "the session remains usable and exposes the cancelled task",
      ),
    );
  },
});
