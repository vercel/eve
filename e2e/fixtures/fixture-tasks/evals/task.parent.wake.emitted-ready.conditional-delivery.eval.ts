import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireBackgroundTaskId, requireSessionStreamIndex } from "./shared.js";

/** A ready-task wake runs the parent model but does not require a channel message. */
export default defineTaskEval({
  description:
    "A completed background task wakes the parent with conditional delivery and can remain silent.",
  transition: {
    primary: "task.parent.wake.emitted-ready",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.lifecycle.complete.accepted-nonterminal",
    ],
    dimensions: { transport: "local", parentPhase: "parked" },
  },
  async test(t) {
    const started = await t.send("TASK-WAKE-CONDITIONAL-DELIVERY");
    started.expectOk();
    started.messageIncludes("TASK-WAKE-CONDITIONAL-STARTED");
    const taskId = requireBackgroundTaskId(started);

    const sessionId = started.sessionId;
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(t, "Conditional task wake"),
    });
    const wake = await live.result();

    wake.expectOk();
    wake.eventsSatisfy("the completed task notification started the wake turn", (events) =>
      events.some(
        (event) =>
          event.type === "message.received" &&
          event.data.message.includes(`Background task ${taskId}`),
      ),
    );
    wake.event("message.completed", {
      count: 1,
      data: (data) => data.finishReason !== "tool-calls" && data.message === null,
    });
    wake.notEvent("message.completed", {
      data: (data) => data.finishReason !== "tool-calls" && data.message !== null,
    });
    await t.require(
      wake.message,
      satisfies((message) => message === undefined, "the task wake delivers no channel message"),
    );
    t.noFailedActions();
  },
});
