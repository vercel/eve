import { describe, expect, it } from "vitest";

import { taskRunWorkflow } from "#execution/tasks/child/workflow.js";
import { sendTaskCommand } from "#execution/tasks/parent/run-parent.js";
import { readWorkflowOwnership, waitForWorkflowCleanup } from "#execution/workflow-lifecycle.js";
import { start } from "#internal/workflow/runtime.js";

describe("workflow ownership acknowledgement", () => {
  it("receives the same owner from concurrent starts and observes its completed cleanup", async () => {
    const input = {
      initialView: {
        metadata: { kind: "tool", name: "ownership-test" },
        status: "working",
        taskId: "task-ownership-test",
      },
      parentContinuationToken: "parent-ownership-test",
      taskInboxToken: "task-ownership-test",
    } as const;
    const runs = await Promise.all([
      start(taskRunWorkflow, [input]),
      start(taskRunWorkflow, [input]),
    ]);
    try {
      const owners = await Promise.all(runs.map((run) => readWorkflowOwnership(run.runId)));
      expect(owners[0]).toEqual(owners[1]);
      const winner = runs.find((run) => run.runId === owners[0]!.runId)!;
      expect(winner).toBeDefined();
      expect(await winner.status).toBe("running");

      const completion = waitForWorkflowCleanup(winner.runId, 5_000);
      await sendTaskCommand({
        taskInboxToken: input.taskInboxToken,
        command: { kind: "complete", data: "done" },
      });
      await sendTaskCommand({ taskInboxToken: input.taskInboxToken, command: { kind: "ready" } });
      await completion;
    } finally {
      await Promise.all(runs.map((run) => run.cancel().catch(() => {})));
    }
  });
});
