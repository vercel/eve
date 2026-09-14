import { defineTaskEval } from "./task-transition.js";
import { requireBackgroundTaskId, requireTaskView, waitForTaskStatus } from "./shared.js";

const CALL_ID = "task-a3-unstartable-worker";

/** A failed remote start is recorded as the admitted background task's terminal state. */
export default defineTaskEval({
  description:
    "An unreachable remote URL returns a task receipt, then fails that task without killing the parent.",
  transition: {
    primary: "task.dispatch.start.rejected-unreachable",
    dimensions: { transport: "remote", parentPhase: "active" },
  },
  async test(t) {
    const started = await t.send("TASK-A3-DISPATCH-START-FAILURE");
    started.expectOk();
    started.messageIncludes("TASK-A3-PARENT-SURVIVED");
    started.event("subagent.completed", {
      count: 1,
      data: {
        backgroundTask: { status: "working" },
        callId: CALL_ID,
        subagentName: "unstartable-worker",
      },
    });
    const taskId = requireBackgroundTaskId(started);
    started.eventsSatisfy("unreachable start exposes one working task receipt", (events) => {
      const completed = events.flatMap((event) =>
        event.type === "action.result" &&
        event.data.result.kind === "tool-result" &&
        event.data.result.callId === CALL_ID
          ? [event]
          : [],
      );
      const result = completed[0]?.data.result;
      const output = result?.output;
      return (
        completed.length === 1 &&
        completed[0]?.data.status === "completed" &&
        result?.kind === "tool-result" &&
        output !== null &&
        typeof output === "object" &&
        Reflect.get(output, "status") === "working" &&
        Reflect.get(output, "taskId") === taskId
      );
    });

    const failed = await waitForTaskStatus(t, t, "TASK-A3-UNKNOWN-VERIFY", taskId, "failed");
    failed.expectOk();
    failed.messageIncludes("TASK-A3-UNKNOWN");
    const view = requireTaskView(failed.requireToolCall("task_cancel").output, taskId);
    if (
      Reflect.get(view, "status") !== "failed" ||
      !hasTaskMetadata(view, "unstartable-worker", "remote") ||
      !hasErrorOutput(view)
    ) {
      throw new Error(`Task ${taskId} did not fail with remote unstartable-worker metadata.`);
    }
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

function hasErrorOutput(task: Record<string, unknown>): boolean {
  const lastOutput = Reflect.get(task, "lastOutput");
  return (
    lastOutput !== null &&
    typeof lastOutput === "object" &&
    Reflect.get(lastOutput, "type") === "error"
  );
}
