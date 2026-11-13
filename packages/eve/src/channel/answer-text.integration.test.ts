import { describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

describe("answerText", () => {
  it("reaches the deliver hook on the message that starts a session and on later ones", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", await (await getWorld()).getDeploymentId());
    const seen: (string | undefined)[] = [];
    const channel = defineChannel({
      routes: [POST("/messages", async () => new Response(null, { status: 204 }))],
      state: {},
      deliver(payload) {
        seen.push(payload.answerText);
      },
    });
    const app = await createTestRuntime({
      agent: { name: "answer-text", limits: { sessionTimeoutMs: false } },
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
      const first = await address.send("Alice: hello", { answerText: "hello", auth: null });
      const stream = captureTurnEvents(getRun(first.sessionId));
      try {
        await stream.nextTurn();
        await address.send("Alice: thanks", { answerText: "thanks", auth: null });
        await stream.nextTurn();
        expect(seen).toEqual(["hello", "thanks"]);
      } finally {
        stream.dispose();
        await getRun(first.sessionId)
          .cancel()
          .catch(() => {});
      }
    });
  }, 60_000);
});
