import { describe, expect, it } from "vitest";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";

const channel = defineChannel({
  routes: [POST("/drop", async () => new Response("ok"))],
  state: {},
  // A channel may drop a delivery, such as a message it does not handle.
  deliver(payload) {
    return payload.message === "drop me" ? undefined : { message: payload.message };
  },
});

describe("pending session history", () => {
  it("keeps history from create() until a message the channel accepts", async () => {
    const continuationToken = "drop-history-session";
    const runtime = await createTestRuntime({
      agent: { name: "pending-history" },
      modules: [
        { loadNamespace: async () => ({ default: channel }), logicalPath: "channels/drop.ts" },
      ],
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {
            history: [
              { role: "user", text: "Earlier question" },
              { role: "assistant", text: "Earlier answer" },
            ],
          },
          serializedContext: buildSerializedContext({
            channelKind: "channel:drop",
            continuationToken,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const inbox = sessionInboxHookToken(continuationToken);
        await waitForHook({ runId: run.runId }, { token: inbox });
        await resumeHook(inbox, { kind: "send", payload: { message: "drop me" } });
        await resumeHook(inbox, { kind: "send", payload: { message: "hello" } });

        const turn = await stream.nextTurn();
        expect(
          turn
            .filter(({ type }) => type === "history.imported" || type === "message.received")
            .map(({ data, type }) => [type, data]),
        ).toEqual([
          [
            "history.imported",
            expect.objectContaining({
              messages: [
                { text: "Earlier question", role: "user" },
                { text: "Earlier answer", role: "assistant" },
              ],
              turnId: "turn_0",
            }),
          ],
          ["message.received", expect.objectContaining({ message: "hello", turnId: "turn_0" })],
        ]);
      } finally {
        stream.dispose();
        await run.cancel().catch(() => {});
      }
    });
  });
});
