import { afterEach, describe, expect, it, vi } from "vitest";

import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { stopIdleSessionSandboxStep } from "#execution/session/idle-sandbox-step.js";
import type { HarnessSession } from "#harness/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { applyValueDelta } from "#shared/value-delta.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("idle sandbox stop step", () => {
  it("returns and clears the marker when the provider never finishes stopping", async () => {
    const called = Promise.withResolvers<void>();
    const runtime = await createTestRuntime({
      sandboxIdle: {
        idleTimeoutMs: 0,
        onSessionIdle: async () => {
          called.resolve();
          await new Promise<never>(() => {});
        },
      },
    });
    await runtime.run(async () => {
      const serializedContext = {
        ...buildSerializedContext({ channelKind: "http" }),
        "eve.sessionId": "idle-stop-hung-provider",
      };
      const checkpoint: HarnessSession = {
        compaction: {},
        continuationToken: "idle-stop-hung-provider",
        history: [],
        sandboxState: { running: { generation: "generation-1", idleTimeoutMs: 0 }, session: null },
        sessionId: serializedContext["eve.sessionId"],
      };
      const sessionState = createDurableSessionState({ session: checkpoint });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const step = stopIdleSessionSandboxStep({ serializedContext, sessionState });
      await called.promise;
      await vi.advanceTimersByTimeAsync(120_000);
      const { stateDelta } = await step;

      const next = applyValueDelta(sessionState, stateDelta.sessionState);
      expect(readDurableSession(next).sandboxState).not.toHaveProperty("running");
      expect(runtime.sandboxEvents).toEqual([`idle:${checkpoint.sessionId}`]);
    });
  });
});
