import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireSessionStreamIndex, requireTaskView } from "./shared.js";

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
    const firstTaskId = notifiedTaskId(firstWake);
    await t.require(
      firstTaskId,
      satisfies(
        (taskId: string) => taskIds.includes(taskId),
        "the first wake belongs to a reviewer task",
      ),
    );
    const firstView = requireTaskView(
      firstWake.requireToolCall("task_peek", { input: { taskIds: [firstTaskId] } }).output,
      firstTaskId,
    );
    await requireFinding(t, firstView, "the first reviewer result supplies the published finding");

    const secondLive = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(firstLive.session, "Late reviewer wake"),
    });
    const wake = await secondLive.result();

    wake.expectOk();
    const lateTaskId = notifiedTaskId(wake);
    await t.require(
      lateTaskId,
      satisfies(
        (taskId: string) => taskIds.includes(taskId) && taskId !== firstTaskId,
        "the late wake belongs to the other reviewer task",
      ),
    );
    const lateView = requireTaskView(
      wake.requireToolCall("task_peek", { input: { taskIds: [lateTaskId] } }).output,
      lateTaskId,
    );
    await requireFinding(t, lateView, "the late reviewer repeats the published finding");
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

function notifiedTaskId(turn: EveEvalTurn): string {
  for (const event of turn.events) {
    if (event.type !== "message.received" || event.data.message === undefined) continue;
    const taskId = /Background task (task_[a-z0-9]+)/iu.exec(event.data.message)?.[1];
    if (taskId !== undefined) return taskId;
  }
  throw new Error("Reviewer wake has no completed-task notification.");
}

async function requireFinding(
  t: EveEvalContext,
  view: Record<string, unknown>,
  description: string,
): Promise<void> {
  await t.require(
    view,
    satisfies(
      (task: Record<string, unknown>) => taskResultText(task)?.includes(REVIEW_FINDING) === true,
      description,
    ),
  );
}

function taskResultText(view: Record<string, unknown>): string | undefined {
  if (view.status !== "completed") return undefined;
  const lastOutput = view.lastOutput;
  if (
    lastOutput === null ||
    typeof lastOutput !== "object" ||
    Reflect.get(lastOutput, "type") !== "result"
  ) {
    return undefined;
  }
  const data = Reflect.get(lastOutput, "data");
  return typeof data === "string" ? data : undefined;
}
