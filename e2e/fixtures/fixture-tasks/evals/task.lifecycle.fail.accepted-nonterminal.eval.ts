import { satisfies } from "eve/evals/expect";

import { requireBackgroundTaskId, requireTaskView, waitForTaskStatus } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const CALL_ID = "task-a2-failing-busy-worker";

/** A child execution failure remains observable through its durable task view. */
export default defineTaskEval({
  description:
    "A background child that fails terminally leaves a failed task with a stable error projection.",
  transition: {
    primary: "task.lifecycle.fail.accepted-nonterminal",
    setup: ["task.dispatch.start.accepted-acknowledged"],
    dimensions: { transport: "local" },
  },
  async test(t) {
    const started = await t.send("TASK-A2-CHILD-FAILURE");
    started.expectOk();
    started.messageIncludes("TASK-A2-CHILD-FAILURE-STARTED");
    started.event("subagent.completed", {
      count: 1,
      data: {
        backgroundTask: { status: "working" },
        callId: CALL_ID,
        subagentName: "busy-worker",
      },
    });
    const taskId = requireBackgroundTaskId(started);

    const failed = await waitForTaskStatus(t, t, "TASK-A2-CHILD-FAILURE-VERIFY", taskId, "failed");
    failed.expectOk();
    failed.messageIncludes("TASK-A2-FAILED");
    const peeked = failed.requireToolCall("task_peek", { input: { taskIds: [taskId] } });
    const view = requireTaskView(peeked.output, taskId);
    await t.require(
      view,
      satisfies(
        (task: Record<string, unknown>) =>
          Reflect.get(task, "taskId") === taskId &&
          Reflect.get(task, "status") === "failed" &&
          hasTaskMetadata(task, "busy-worker", "local") &&
          hasFailureOutput(task, "SUBAGENT_EXECUTION_FAILED"),
        "failed task keeps its id, busy-worker metadata, and stable error code",
      ),
    );
  },
});

function hasTaskMetadata(task: Record<string, unknown>, name: string, mode: string): boolean {
  const metadata = Reflect.get(task, "metadata");
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    Reflect.get(metadata, "kind") === "subagent" &&
    Reflect.get(metadata, "mode") === mode &&
    Reflect.get(metadata, "name") === name &&
    typeof Reflect.get(metadata, "agentId") === "string"
  );
}

function hasFailureOutput(task: Record<string, unknown>, code: string): boolean {
  const lastOutput = Reflect.get(task, "lastOutput");
  if (
    lastOutput === null ||
    typeof lastOutput !== "object" ||
    Reflect.get(lastOutput, "type") !== "error"
  ) {
    return false;
  }
  const data = Reflect.get(lastOutput, "data");
  return data !== null && typeof data === "object" && Reflect.get(data, "code") === code;
}
