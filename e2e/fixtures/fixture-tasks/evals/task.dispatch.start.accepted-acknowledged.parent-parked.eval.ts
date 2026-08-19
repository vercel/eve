import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireBackgroundTaskId, requireSessionStreamIndex } from "./shared.js";

/** An admitted background task yields its conversation parent until a task notification arrives. */
export default defineTaskEval({
  description:
    "A background task receipt is persisted before the parent parks, without a receipt-follow-up model call.",
  transition: {
    primary: "task.dispatch.start.accepted-acknowledged",
    dimensions: { transport: "local", parentPhase: "parked" },
  },
  async test(t) {
    const dispatched = await t.send("TASK-DISPATCH-PARKS-PARENT");
    dispatched.expectOk();
    dispatched.event("step.started", { count: 1 });
    dispatched.event("session.waiting", { count: 1 });
    dispatched.notEvent("message.completed", {
      data: (data) => data.finishReason !== "tool-calls",
    });
    await t.require(
      dispatched.message,
      satisfies(
        (message) => message === undefined,
        "task admission parks without a receipt-follow-up model message",
      ),
    );

    const taskId = requireBackgroundTaskId(dispatched);
    const sessionId = dispatched.sessionId;
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(t, "Task completion wake"),
    });
    const wake = await live.result();

    wake.expectOk();
    wake.event("step.started", { count: 1 });
    wake.eventsSatisfy("the next model call is caused by the task notification", (events) =>
      events.some(
        (event) =>
          event.type === "message.received" &&
          event.data.message.includes(`Background task ${taskId}`),
      ),
    );
    t.noFailedActions();
  },
});
