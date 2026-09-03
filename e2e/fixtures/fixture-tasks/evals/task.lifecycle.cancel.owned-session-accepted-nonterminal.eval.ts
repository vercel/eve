import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  waitForTaskInput,
  waitForTaskStatus,
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
    const started = await t.send("TASK-CANCEL-SETUP");
    started.expectOk();
    const taskId = requireBackgroundTaskId(started);
    const blocked = await waitForTaskInput(t, t, "release");
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

    const verified = await waitForTaskStatus(
      t,
      blocked.session,
      "TASK-CANCEL-VERIFY",
      taskId,
      "cancelled",
    );
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
