import { defineTaskEval } from "./task-transition.js";
import {
  requireBackgroundTaskId,
  sendAndFollowQueuedTurn,
  waitForCompletedTask,
} from "./shared.js";

/** A persistent child with a nonterminal task rejects every competing continuation. */
export default defineTaskEval({
  description:
    "One agentId continuation is admitted; competing continuations are rejected as AGENT_BUSY.",
  transition: {
    primary: "task.agent.continue.rejected-agent-busy",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.lifecycle.complete.accepted-nonterminal",
      "task.agent.continue.accepted-terminal-available",
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
      data: { result: { kind: "subagent-result", subagentName: "busy-worker" } },
    });
    raced.calledSubagent("busy-worker", {
      count: 1,
      status: "completed",
    });
    raced.calledSubagent("busy-worker", {
      count: 1,
      output: (output) => isBusyRejection(output, admittedTaskId),
      status: "failed",
    });

    const later = await sendAndFollowQueuedTurn(
      t,
      `CHILD-TASK-EXCLUSIVITY-LATER ${agentId}`,
      race.session,
      { allowFailedActions: true },
    );
    later.turn.calledSubagent("busy-worker", {
      count: 1,
      output: (output) => isBusyRejection(output, admittedTaskId),
      status: "failed",
    });

    await waitForCompletedTask(t, later.session, "CHILD-TASK-EXCLUSIVITY-VERIFY", admittedTaskId);
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
  if (output === null || typeof output !== "object") return false;
  const message = Reflect.get(output, "message");
  return (
    Reflect.get(output, "code") === "AGENT_BUSY" &&
    typeof message === "string" &&
    !Object.hasOwn(output, "taskId") &&
    (activeTaskId === undefined || message.includes(activeTaskId))
  );
}
