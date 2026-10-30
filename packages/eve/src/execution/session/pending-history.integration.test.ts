import { describe, expect, it } from "vitest";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";

const channel = defineChannel({
  routes: [POST("/drop", async () => new Response("ok"))],
  state: {},
  // A channel drops a delivery it does not handle by replacing it with nothing to deliver.
  deliver(payload) {
    return payload.message === "drop me" ? {} : undefined;
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
        const send = (message: string) =>
          resumeHook(inbox, {
            kind: "send",
            payload: { message },
            delivery: createChannelDeliveryMetadata({
              channelKind: "channel:drop",
              channelName: "drop",
            }),
          });
        await send("drop me");
        await send("hello");

        const turn = await stream.nextTurn();
        expect(
          turn.filter(({ type }) => type === "delivery.consumed").map(({ data }) => data),
        ).toEqual([
          expect.objectContaining({
            history: [
              { role: "user", text: "Earlier question" },
              { role: "assistant", text: "Earlier answer" },
            ],
            parts: [{ kind: "text", text: "hello" }],
          }),
        ]);
      } finally {
        stream.dispose();
        await run.cancel().catch(() => {});
      }
    });
  });
});
