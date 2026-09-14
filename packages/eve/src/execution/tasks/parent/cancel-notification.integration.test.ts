import { describe, expect, it } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { taskCancelNotificationWorkflow } from "#internal/testing/task-cancel-notification-workflow.js";
import { start } from "#internal/workflow/runtime.js";

describe("task cancellation parent notification", () => {
  it("delivers the committed view from the parent step after forcing a slow lifecycle to stop", async () => {
    const runtime = await createTestRuntime({ agent: { name: "task-cancel-notification" } });
    await runtime.run(async () => {
      const run = await start(taskCancelNotificationWorkflow, []);
      try {
        const result = await run.returnValue;
        expect(result.taskRunStatus).toBe("cancelled");
        expect(result.view.status).toBe("cancelled");
        expect(result.notification).toMatchObject({
          kind: "send",
          payload: {
            message: `Background task ${result.view.taskId} (slow-cancel) is cancelled.`,
            task: { views: [result.view] },
          },
          taskDeliveryId: `${result.view.taskId}:ready:cancelled`,
        });
      } finally {
        const status = await run.status;
        if (status === "pending" || status === "running") await run.cancel();
      }
    });
  }, 30_000);
});
