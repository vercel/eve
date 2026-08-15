import { describe, expect, it } from "vitest";
import { start } from "#internal/workflow/runtime.js";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  durableSessionRetryFixtureWorkflow,
  durableSessionStoreFixtureWorkflow,
} from "#internal/testing/durable-session-workflow.js";

/**
 * Exercises `readDurableSession` / `createDurableSessionState` inside
 * a real workflow runtime, including returned state under step retry.
 */
describe("durableSessionStore integration", () => {
  it("each step's readDurableSession returns the immediately-preceding write", async () => {
    const runtime = createTestRuntime({ agent: { name: "durable-session-store-fixture" } });

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
    });
  });

  it("a standalone read step after several writes returns the latest returned state", async () => {
    const runtime = createTestRuntime({ agent: { name: "durable-session-store-fixture-tail" } });

    await runtime.run(async () => {
      const run = await start(durableSessionStoreFixtureWorkflow, [
        {
          markers: [
            { marker: "first", historyDepth: 0 },
            { marker: "second", historyDepth: 2 },
            { marker: "third", historyDepth: 4 },
            { marker: "fourth", historyDepth: 6 },
          ],
        },
      ]);

      const result = await run.returnValue;

      // The read step runs after the loop with no intervening write of
      // its own, so this asserts the returned state still carries the
      // latest snapshot across a later step boundary.
      expect(result.tailReadAfterAllWrites).toEqual({
        historyDepth: 6,
        marker: "fourth",
        sessionId: result.sessionId,
      });
    });
  });

  it("a write-step retry's returned state is what the subsequent read returns", async () => {
    const runtime = createTestRuntime({ agent: { name: "durable-session-store-fixture-retry" } });

    await runtime.run(async () => {
      const run = await start(durableSessionRetryFixtureWorkflow, []);

      const result = await run.returnValue;

      // The retry-forcing step throws on attempt 1 and returns state on
      // attempt 2. The subsequent read must observe the retry's state,
      // not the seed state or any orphan from attempt 1.
      expect(result.writeAttempt).toBe(2);
      expect(result.readAfterRetry).toEqual({
        historyDepth: 9,
        marker: "after-retry",
        sessionId: result.sessionId,
      });
    });
  });
});
