import { describe, expect, it } from "vitest";

import { start } from "#internal/workflow/runtime.js";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { taskModelRetryFixtureWorkflow } from "#internal/testing/task-model-retry-workflow.js";

describe("task model retry integration", () => {
  it("retries a recoverable task error from the committed session snapshot", async () => {
    const runtime = createTestRuntime({ agent: { name: "task-model-retry-fixture" } });

    await runtime.run(async () => {
      const run = await start(taskModelRetryFixtureWorkflow, [{ failThroughAttempt: 1 }]);
      const outcome = await run.returnValue;

      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed") return;

      expect(outcome.parentNotifications).toBe(0);
      expect(outcome.result.attempt).toBe(2);
      expect(outcome.result.output).toBe("Recovered task output.");
      expect(outcome.result.historyBeforeModelCall).toEqual([
        { content: "Complete the delegated task.", role: "user" },
        { content: "Prior durable work is complete.", role: "assistant" },
      ]);
      expect(outcome.result.history).toContainEqual({
        content: "Prior durable work is complete.",
        role: "assistant",
      });
      expect(JSON.stringify(outcome.result.history)).toContain("Recovered task output.");
    });
  });

  it("notifies the parent once after Workflow exhausts persistent failures", async () => {
    const runtime = createTestRuntime({ agent: { name: "task-model-retry-exhaustion-fixture" } });

    await runtime.run(async () => {
      const run = await start(taskModelRetryFixtureWorkflow, [
        { failThroughAttempt: Number.MAX_SAFE_INTEGER },
      ]);
      const outcome = await run.returnValue;

      expect(outcome).toMatchObject({
        kind: "failed",
        parentNotifications: 1,
      });
      if (outcome.kind !== "failed") return;
      expect(outcome.failureMessage).toContain(
        "failed after 3 retries: recoverable task failure on Workflow attempt 4",
      );
    });
  });
});
