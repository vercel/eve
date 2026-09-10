import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireBackgroundTaskId, waitForTaskNotification } from "./shared.js";

export default defineTaskEval({
  description:
    "A background child no longer advertises task_update, and its final tool report still reaches the parent.",
  transition: {
    primary: "task.lifecycle.complete.accepted-nonterminal",
    setup: ["task.dispatch.start.accepted-acknowledged"],
    dimensions: { transport: "local" },
  },
  async test(t) {
    const started = await t.send(
      "Alice asks Bob to summarize the available tools for a background task.",
    );
    started.expectOk();
    started.calledSubagent("tool-surface-worker", { count: 1 });
    started.event("subagent.completed", {
      count: 1,
      data: {
        backgroundTask: { status: "working" },
        callId: "task-child-tool-surface",
        subagentName: "tool-surface-worker",
      },
    });
    const taskId = requireBackgroundTaskId(started);

    const completed = await waitForTaskNotification(t, t, taskId, "completed", [started]);
    completed.turn.expectOk();
    const report = completed.turn.message;
    if (report === undefined) throw new Error("Parent did not return the child's tool report.");
    await t.require(
      JSON.parse(report) as unknown,
      satisfies((value) => {
        if (value === null || typeof value !== "object") return false;
        const tools = Reflect.get(value, "tools");
        return (
          Reflect.get(value, "result") === "TASK-CHILD-FINAL-RESULT" &&
          Array.isArray(tools) &&
          tools.every((tool) => typeof tool === "string") &&
          !tools.includes("task_update")
        );
      }, "the child reports its advertised tools without task_update and a final result"),
    );
    completed.turn.eventsSatisfy(
      "the final child report reaches its owning parent task",
      (events) =>
        events.some(
          (event) =>
            event.type === "message.received" &&
            typeof event.data.message === "string" &&
            event.data.message.includes(
              `Background task ${taskId} (tool-surface-worker) is completed.`,
            ) &&
            event.data.message.includes(report),
        ),
    );
    t.notCalledTool("task_update");
    t.noFailedActions();
  },
});
