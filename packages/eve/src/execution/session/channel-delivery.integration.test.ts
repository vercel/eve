import { describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { defineHook } from "#public/definitions/hook.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

/** A slow platform call, such as a status update. */
const platformCall = () => new Promise((resolve) => setTimeout(resolve, 200));

describe("channel event delivery", () => {
  it("runs the model while a channel handler is still working, and keeps what the handler saved", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", await (await getWorld()).getDeploymentId());
    const released = Promise.withResolvers<void>();
    const seen: { readonly type: string; readonly startedBefore: number }[] = [];
    const channel = defineChannel<{ started: number }, { state: { started: number } }>({
      context: (state) => ({ state }),
      routes: [POST("/messages", async () => new Response(null, { status: 204 }))],
      state: { started: 0 },
      events: {
        async "turn.started"(_event, { channel }) {
          seen.push({ type: "turn.started", startedBefore: channel.state.started });
          // A slow platform call, such as a status update.
          if (channel.state.started === 0) await released.promise;
          channel.state.started += 1;
        },
        "content.completed"() {
          seen.push({ type: "content.completed", startedBefore: -1 });
        },
      },
    });
    const app = await createTestRuntime({
      agent: { name: "channel-delivery", limits: { sessionTimeoutMs: false } },
      modules: [
        { loadNamespace: async () => ({ default: channel }), logicalPath: "channels/chat.ts" },
      ],
    });
    await app.run(async () => {
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const { from } = createChannelOperations({
        adapter: { kind: "channel:chat" },
        channelName: "chat",
        runtime,
      });
      const address = from(crypto.randomUUID());
      const first = await address.send("Alice: hello", { auth: null });
      const stream = captureTurnEvents(getRun(first.sessionId));
      try {
        // The reply streams while the first turn's handler still waits.
        await stream.nextUntil((event) => event.type === "content.completed");
        expect(seen).toEqual([{ type: "turn.started", startedBefore: 0 }]);
        released.resolve();
        await stream.nextUntil((event) => event.type === "turn.settled");
        // Handlers still run in order, and the step saved the state the first one left.
        await address.send("Alice: thanks", { auth: null });
        await stream.nextTurn();
        expect(seen).toEqual([
          { type: "turn.started", startedBefore: 0 },
          { type: "content.completed", startedBefore: -1 },
          { type: "turn.started", startedBefore: 1 },
          { type: "content.completed", startedBefore: -1 },
        ]);
      } finally {
        released.resolve();
        stream.dispose();
        await getRun(first.sessionId)
          .cancel()
          .catch(() => {});
      }
    });
  }, 60_000);

  it("runs a cancelled turn's handlers before the step that settles it", async () => {
    const handled: string[] = [];
    const channel = defineChannel({
      routes: [POST("/messages", async () => new Response(null, { status: 204 }))],
      events: {
        async "turn.started"() {
          await platformCall();
          handled.push("turn.started");
        },
        "turn.settled"(event) {
          handled.push(`turn.settled:${event.data.outcome}`);
        },
      },
    });
    let admitted = 0;
    const stop = defineHook({
      events: {
        "delivery.admitted"(_event, ctx) {
          // The second message: the turn it opens is cancelled before its first model call.
          if (++admitted === 2) ctx.cancel();
        },
      },
    });
    const app = await createTestRuntime({
      agent: { name: "channel-delivery-cancel", limits: { sessionTimeoutMs: false } },
      modules: [
        { loadNamespace: async () => ({ default: channel }), logicalPath: "channels/chat.ts" },
        { loadNamespace: async () => ({ default: stop }), logicalPath: "hooks/stop.ts" },
      ],
    });
    await app.run(async () => {
      const token = "channel:chat:cancel";
      const run = await startTestSession("in-process", {
        input: { message: "Alice: hello" },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: buildSerializedContext({
          channelKind: "channel:chat",
          continuationToken: token,
        }),
      });
      const send = (message: string) =>
        resumeRoutedHook(sessionInboxHookToken(token), {
          delivery: createChannelDeliveryMetadata({
            channelKind: "channel:chat",
            channelName: "chat",
          }),
          kind: "send",
          payload: { message },
        });
      const stream = captureTurnEvents(run);
      try {
        await stream.nextTurn();
        await send("Alice: never mind");
        await stream.nextTurn();
        await send("Alice: still there?");
        await stream.nextTurn();
        // A reader can see a turn settle before its handlers finish.
        await vi.waitFor(() =>
          expect(handled).toEqual([
            "turn.started",
            "turn.settled:completed",
            "turn.started",
            "turn.settled:cancelled",
            "turn.started",
            "turn.settled:completed",
          ]),
        );
      } finally {
        stream.dispose();
        await run.cancel().catch(() => {});
      }
    });
  }, 60_000);

  it("runs a failed step's handlers before its retry", async () => {
    const handled: string[] = [];
    const channel = defineChannel({
      routes: [POST("/messages", async () => new Response(null, { status: 204 }))],
      events: {
        async "turn.started"() {
          await platformCall();
          handled.push("turn.started");
        },
        "content.completed"() {
          handled.push("content.completed");
        },
      },
    });
    const app = await createTestRuntime({
      agent: { name: "channel-delivery-retry", limits: { sessionTimeoutMs: false } },
      modules: [
        { loadNamespace: async () => ({ default: channel }), logicalPath: "channels/chat.ts" },
      ],
    });
    let failed = false;
    await app.run(async () => {
      const run = await startTestSession(
        "in-process",
        {
          input: { message: "Alice: hello" },
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          serializedContext: buildSerializedContext({
            channelKind: "channel:chat",
            continuationToken: "channel:chat:retry",
          }),
        },
        {
          stepFaults: {
            // The reply's first write fails, after the turn's start was written.
            failWrite(_step, chunk) {
              if (failed || !new TextDecoder().decode(chunk).includes('"content.')) return false;
              return (failed = true);
            },
          },
        },
      );
      const stream = captureTurnEvents(run);
      try {
        await stream.nextUntil((event) => event.type === "turn.settled");
        expect(failed).toBe(true);
        // The retry adopts the start its attempt wrote, without running its handler again.
        await vi.waitFor(() => expect(handled).toEqual(["turn.started", "content.completed"]));
      } finally {
        stream.dispose();
        await run.cancel().catch(() => {});
      }
    });
  }, 60_000);
});
