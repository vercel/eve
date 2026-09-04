import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import {
  requireBackgroundTaskId,
  requireTaskView,
  parseToolErrorOutput,
  sendAndFollowQueuedTurn,
  waitForCompletedTask,
  waitForTaskNotification,
} from "./shared.js";

/** Same-batch calls compete for one claim; a later message steers the admitted task. */
export default defineTaskEval({
  description:
    "One same-batch continuation is admitted; later steering cancels its task and reuses the child.",
  transition: {
    primary: "task.agent.steer.accepted-busy",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.lifecycle.complete.accepted-nonterminal",
      "task.agent.continue.accepted-terminal-available",
      "task.agent.continue.rejected-agent-busy",
    ],
    dimensions: { transport: "local", parentPhase: "active" },
  },
  async test(t) {
    const setup = await t.send("CHILD-TASK-EXCLUSIVITY-SETUP");
    setup.expectOk();
    setup.messageIncludes("CHILD-TASK-EXCLUSIVITY-READY");
    const initialTaskId = requireBackgroundTaskId(setup);
    const initial = await waitForCompletedTask(
      t,
      t,
      "CHILD-TASK-EXCLUSIVITY-VERIFY",
      initialTaskId,
    );
    const agentId = agentIdFromTaskView(
      initial.requireToolCall("task_cancel").output,
      initialTaskId,
    );

    const race = await sendAndFollowQueuedTurn(t, "CHILD-TASK-EXCLUSIVITY-RACE", t, {
      allowFailedActions: true,
    });
    const raced = race.turn;
    raced.expectOk();
    raced.messageIncludes("CHILD-TASK-EXCLUSIVITY-RACE-DONE");

    const admittedTaskId = requireBackgroundTaskId(raced);
    raced.event("action.result", {
      count: 2,
      data: { result: { kind: "tool-result", toolName: "busy-worker" } },
    });
    raced.calledSubagent("busy-worker", {
      count: 1,
      status: "completed",
    });
    raced.calledTool("busy-worker", {
      count: 1,
      output: (output) => isBusyRejection(output, admittedTaskId),
      status: "failed",
    });

    const later = await sendAndFollowQueuedTurn(
      t,
      `CHILD-TASK-EXCLUSIVITY-LATER ${agentId}`,
      race.session,
    );
    later.turn.expectOk();
    later.turn.calledSubagent("busy-worker", { count: 1, status: "completed" });
    const steeredTaskId = requireBackgroundTaskId(later.turn);
    await t.require(
      steeredTaskId,
      satisfies((taskId) => taskId !== admittedTaskId, "steering creates a new task identity"),
    );

    const cancelled = await waitForTaskNotification(
      t,
      later.session,
      admittedTaskId,
      "cancelled",
      later.observedTurns,
    );
    const completed = await waitForCompletedTask(
      t,
      cancelled.session,
      "CHILD-TASK-EXCLUSIVITY-VERIFY",
      steeredTaskId,
    );
    const output = completed.requireToolCall("task_cancel").output;
    await t.require(
      agentIdFromTaskView(output, steeredTaskId),
      satisfies((id) => id === agentId, "steering retains the same agent identity"),
    );
    const view = requireTaskView(output, steeredTaskId);
    await t.require(
      view.lastOutput,
      satisfies(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          Reflect.get(value, "data") === "BUSY-WORKER:Return BUSY-WORKER-LATER.",
        "the replacement task completes with the steering message's result",
      ),
    );
  },
});

function agentIdFromTaskView(output: unknown, taskId: string): string {
  if (output === null || typeof output !== "object") throw new Error("No task view output.");
  const tasks = Reflect.get(output, "tasks");
  if (!Array.isArray(tasks)) throw new Error("No task views.");
  const task = tasks.find(
    (value) =>
      value !== null && typeof value === "object" && Reflect.get(value, "taskId") === taskId,
  );
  const metadata = task !== null && typeof task === "object" ? Reflect.get(task, "metadata") : null;
  const agentId =
    metadata !== null && typeof metadata === "object" ? Reflect.get(metadata, "agentId") : null;
  if (typeof agentId !== "string") throw new Error("Task view has no agent id.");
  return agentId;
}

function isBusyRejection(output: unknown, activeTaskId?: string): boolean {
  output = parseToolErrorOutput(output);
  if (output === null || typeof output !== "object") return false;
  const message = Reflect.get(output, "message");
  return (
    Reflect.get(output, "code") === "AGENT_BUSY" &&
    typeof message === "string" &&
    !Object.hasOwn(output, "taskId") &&
    (activeTaskId === undefined || message.includes(activeTaskId))
  );
}
