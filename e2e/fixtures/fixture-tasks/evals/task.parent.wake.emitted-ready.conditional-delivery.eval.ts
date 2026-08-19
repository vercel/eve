import type { EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireSessionStreamIndex } from "./shared.js";

const REVIEW_FINDING = "blocker: task admission can discard deferred user input.";

/** A late reviewer result already represented in the conversation requires no new message. */
export default defineTaskEval({
  description:
    "A completed reviewer repeats a finding already delivered to the user, so its wake remains silent.",
  transition: {
    primary: "task.parent.wake.emitted-ready",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.lifecycle.complete.accepted-nonterminal",
    ],
    dimensions: { transport: "local", parentPhase: "parked" },
  },
  async test(t) {
    const started = await t.send("TASK-WAKE-REDUNDANT-REVIEW");
    started.expectOk();
    started.calledSubagent("busy-worker", { count: 2 });

    const taskIds = started.events.flatMap((event) =>
      event.type === "subagent.completed" && event.data.backgroundTask !== undefined
        ? [event.data.backgroundTask.taskId]
        : [],
    );
    await t.require(
      taskIds,
      satisfies(
        (ids: readonly string[]) => ids.length === 2 && new Set(ids).size === 2,
        "two distinct reviewer task receipts",
      ),
    );

    const sessionId = started.sessionId;
    const firstLive = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(t, "First reviewer wake"),
    });
    const firstWake = await firstLive.result();

    firstWake.expectOk();
    firstWake.messageIncludes(`request changes on PR #2277.\n\n- ${REVIEW_FINDING}`);
    const firstNotification = requireTaskNotification(firstWake);
    await t.require(
      firstNotification,
      satisfies(
        (notification: TaskNotification) =>
          taskIds.includes(notification.taskId) && notification.message.includes(REVIEW_FINDING),
        "the first wake carries one reviewer's result",
      ),
    );
    firstWake.notCalledTool("task_peek");

    const secondLive = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(firstLive.session, "Late reviewer wake"),
    });
    const wake = await secondLive.result();

    wake.expectOk();
    const lateNotification = requireTaskNotification(wake);
    await t.require(
      lateNotification,
      satisfies(
        (notification: TaskNotification) =>
          taskIds.includes(notification.taskId) &&
          notification.taskId !== firstNotification.taskId &&
          notification.message.includes(REVIEW_FINDING),
        "the late wake carries the other reviewer's redundant result",
      ),
    );
    wake.notCalledTool("task_peek");
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
    t.notCalledTool("task_peek");
    t.noFailedActions();
  },
});

interface TaskNotification {
  readonly message: string;
  readonly taskId: string;
}

function requireTaskNotification(turn: EveEvalTurn): TaskNotification {
  for (const event of turn.events) {
    if (event.type !== "message.received" || typeof event.data.message !== "string") continue;
    const taskId = /Background task (task_[a-z0-9]+)/iu.exec(event.data.message)?.[1];
    if (taskId !== undefined) return { message: event.data.message, taskId };
  }
  throw new Error("Reviewer wake has no completed-task notification.");
}
