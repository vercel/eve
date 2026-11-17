import { describe, expect, it } from "vitest";
import { start } from "#internal/workflow/runtime.js";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  durableSessionRetryFixtureWorkflow,
  durableSessionStoreFixtureWorkflow,
} from "#internal/testing/durable-session-workflow.js";

describe("durableSessionStore integration", () => {
  it("each step's readDurableSession returns the immediately-preceding write", async () => {
    const runtime = await createTestRuntime({ agent: { name: "durable-session-store-fixture" } });

    await runtime.run(async () => {
      const run = await start(durableSessionStoreFixtureWorkflow, [
        {
          markers: [
            { marker: "alpha", historyDepth: 1 },
            { marker: "beta", historyDepth: 3 },
            { marker: "gamma", historyDepth: 5 },
          ],
        },
      ]);

      const result = await run.returnValue;

      expect(result.readsAfterEachWrite).toEqual([
        { historyDepth: 1, marker: "alpha", sessionId: result.sessionId },
        { historyDepth: 3, marker: "beta", sessionId: result.sessionId },
        { historyDepth: 5, marker: "gamma", sessionId: result.sessionId },
      ]);
      expect(result.tailReadAfterAllWrites).toEqual({
        historyDepth: 5,
        marker: "gamma",
        sessionId: result.sessionId,
      });
    });
  });

  it("a write-step retry's returned state is what the subsequent read returns", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "durable-session-store-fixture-retry" },
    });

    await runtime.run(async () => {
      const run = await start(durableSessionRetryFixtureWorkflow, []);

      const result = await run.returnValue;

      expect(result.writeAttempt).toBe(2);
      expect(result.readAfterRetry).toEqual({
        historyDepth: 9,
        marker: "after-retry",
        sessionId: result.sessionId,
      });
    });
  });
});
