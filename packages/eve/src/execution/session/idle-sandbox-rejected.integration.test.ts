import { describe, expect, it, vi } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import { defineHook } from "#public/definitions/hook.js";

const stopStep = vi.hoisted(() => ({ calls: 0, rejects: true }));

vi.mock("#execution/session/idle-sandbox-step.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#execution/session/idle-sandbox-step.js")>();
  return {
    ...actual,
    stopIdleSessionSandboxStep: async (
      input: Parameters<typeof actual.stopIdleSessionSandboxStep>[0],
    ) => {
      stopStep.calls += 1;
      if (stopStep.rejects) throw new Error("The idle stop step failed.");
      return await actual.stopIdleSessionSandboxStep(input);
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });

describe("idle sandbox stop step that rejects", () => {
  it("keeps the session running and tries again only after the next turn", async () => {
    let turn = 0;
    const runtime = await createTestRuntime({
      agent: { name: "idle-stop-rejected" },
      modules: [
        {
          logicalPath: "hooks/sandbox.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                async "turn.started"(_event, ctx) {
                  turn += 1;
                  if (turn === 1) await ctx.getSandbox();
                },
              },
            }),
          }),
        },
      ],
      sandboxIdle: { idleTimeoutMs: 0 },
    });
    await runtime.run(async () => {
      const run = await startTestSession("in-process", {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        sessionTimeoutMs: false,
        input: { message: "Alice opens the project notes." },
        serializedContext: buildSerializedContext({ channelKind: "http" }),
      });
      const inbox = sessionInboxHookToken(sessionCommandHookToken(run.runId));
      const stream = captureTurnEvents(run);
      try {
        await stream.nextTurn();
        await vi.waitFor(() => expect(stopStep.calls).toBe(1));

        await resumeRoutedHook(inbox, { deliveryId: "cancel-while-idle", kind: "cancel" });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(stopStep.calls).toBe(1);

        stopStep.rejects = false;
        await resumeRoutedHook(inbox, {
          auth: null,
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          kind: "send",
          payload: { message: "Alice asks for a short greeting." },
        });
        await stream.nextTurn();
        await vi.waitFor(() =>
          expect(runtime.sandboxEvents).toEqual([
            `definition:${run.runId}`,
            `start:${run.runId}`,
            `idle:${run.runId}`,
          ]),
        );
        expect(stopStep.calls).toBe(2);
      } finally {
        stream.dispose();
        await run.cancel().catch(() => undefined);
      }
    });
  });
});
