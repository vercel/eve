import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import {
  requireSessionStreamIndex,
  type TaskEvalSessionDriver,
  waitForTaskInput,
} from "./shared.js";

const REVIEW_FINDING = "blocker: task admission can discard deferred user input.";

/** Related reviewer results stay silent until their same-turn cohort settles. */
export default defineTaskEval({
  description:
    "Related reviewer wakes remain silent while pending, then produce one settled report.",
  transition: {
    primary: "task.parent.wake.emitted-ready",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.input.require.accepted-valid-batch",
      "task.input.answer.accepted-complete",
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

    const blocked = await waitForTaskInput(t, t, "hold");
    const firstObserved = await waitForTaskNotification(
      t,
      blocked.session,
      blocked.observedTurns,
      "First reviewer wake",
    );
    const firstWake = firstObserved.turn;

    firstWake.expectOk();
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
    firstWake.event("message.completed", {
      count: 1,
      data: (data) => data.finishReason !== "tool-calls" && data.message === null,
    });
    firstWake.notEvent("message.completed", {
      data: (data) => data.finishReason !== "tool-calls" && data.message !== null,
    });
    await t.require(
      firstWake.message,
      satisfies((message) => message === undefined, "the pending cohort wake is silent"),
    );

    const released = await firstObserved.session.respond([
      {
        optionId: "approve",
        requestId: blocked.request.requestId,
      },
    ]);
    released.expectOk();
    released.noFailedActions();

    const lateObserved = await waitForTaskNotification(
      t,
      firstObserved.session,
      [released],
      "Late reviewer wake",
    );
    const wake = lateObserved.turn;

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
    wake.messageIncludes(`request changes on PR #2277.\n\n- ${REVIEW_FINDING}`);
    wake.event("message.completed", {
      count: 1,
      data: (data) => data.finishReason !== "tool-calls" && data.message !== null,
    });
    t.notCalledTool("task_peek");
    t.noFailedActions();
  },
});

interface TaskNotification {
  readonly message: string;
  readonly taskId: string;
}

interface ObservedTaskNotification {
  readonly session: TaskEvalSessionDriver;
  readonly turn: EveEvalTurn;
}

async function waitForTaskNotification(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  observedTurns: readonly EveEvalTurn[],
  operation: string,
): Promise<ObservedTaskNotification> {
  const observed = observedTurns.find((turn) => taskNotification(turn) !== undefined);
  if (observed !== undefined) return { session: initialSession, turn: observed };

  const sessionId = initialSession.sessionId;
  if (sessionId === undefined) throw new Error(`${operation} has no parent session id.`);
  const live = t.target.watchTurn(sessionId, {
    startIndex: requireSessionStreamIndex(initialSession, operation),
  });
  const turn = await live.result();
  if (taskNotification(turn) === undefined) {
    throw new Error(`${operation} has no completed-task notification.`);
  }
  return { session: live.session, turn };
}

function requireTaskNotification(turn: EveEvalTurn): TaskNotification {
  const notification = taskNotification(turn);
  if (notification !== undefined) return notification;
  throw new Error("Reviewer wake has no completed-task notification.");
}

function taskNotification(turn: EveEvalTurn): TaskNotification | undefined {
  for (const event of turn.events) {
    if (event.type !== "message.received" || typeof event.data.message !== "string") continue;
    const taskId = /Background task (task_[a-z0-9]+)/iu.exec(event.data.message)?.[1];
    if (taskId !== undefined) return { message: event.data.message, taskId };
  }
  return undefined;
}
