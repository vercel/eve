import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelOperations } from "#channel/channel-operations.js";
import { createSession } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { waitForParkedTurnStep } from "#internal/testing/session-test-helpers.js";
import { defineHook } from "#public/definitions/hook.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const HOLD_MS = 2_000;
const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "roster",
  principalId: "roster:me",
  principalType: "user",
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("queueHoldMs", () => {
  it("holds an idle session's queued message and folds the ones that follow into its turn", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", await (await getWorld()).getDeploymentId());
    let turns = 0;
    const app = await createTestRuntime({
      agent: { name: "queue-hold", limits: { queueHoldMs: HOLD_MS, sessionTimeoutMs: false } },
      modules: [
        {
          logicalPath: "hooks/record.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "turn.started"() {
                  turns += 1;
                },
              },
            }),
          }),
        },
      ],
    });
    await app.run(async () => {
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const receipt = await createChannelOperations({
        adapter: { kind: "http" },
        channelName: "test",
        runtime,
      })
        .from(crypto.randomUUID())
        .send("Open the session.", { auth });
      const stream = captureTurnEvents(getRun(receipt.sessionId));
      let completed = false;
      try {
        await stream.nextTurn();
        await waitForParkedTurnStep(receipt.sessionId);
        expect(turns).toBe(1);

        const session = createSession(receipt.sessionId, runtime);
        const heldAt = Date.now();
        await session.send("First post.", { auth, turnPolicy: "queue" });
        await pause(500);
        expect(turns).toBe(1);
        await session.send("Second post.", { auth, turnPolicy: "queue" });
        await stream.nextTurn();
        expect(Date.now() - heldAt).toBeGreaterThanOrEqual(HOLD_MS - 250);
        await waitForParkedTurnStep(receipt.sessionId, 2);
        await pause(500);
        expect(turns).toBe(2);

        await session.send("Steer now.", { auth });
        await stream.nextTurn();
        await waitForParkedTurnStep(receipt.sessionId, 3);
        expect(turns).toBe(3);
        await session.end();
        completed = true;
      } finally {
        stream.dispose();
        if (!completed && ["pending", "running"].includes(await getRun(receipt.sessionId).status)) {
          await getRun(receipt.sessionId).cancel();
        }
      }
    });
  }, 60_000);
});
