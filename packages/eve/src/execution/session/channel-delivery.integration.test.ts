import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { defineDynamic } from "#dynamic/definition.js";
import { mockModel } from "#evals/mock-model.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import type { ProgrammaticAgentModule } from "#compiler/source-graph.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import { defineAgent } from "#public/definitions/agent.js";
import { type Channel, defineChannel, POST } from "#public/definitions/channel.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineTool } from "#tools/definition.js";

const platformCall = () => new Promise((resolve) => setTimeout(resolve, 200));

const routes = [POST("/messages", async () => new Response(null, { status: 204 }))];

afterEach(() => {
  vi.restoreAllMocks();
});

async function converse(input: {
  readonly name: string;
  readonly channel: Channel<any>;
  readonly modules?: readonly ProgrammaticAgentModule[];
  readonly respond?: Parameters<typeof mockModel>[0];
  readonly then?: readonly string[];
}): Promise<void> {
  const modules = [
    { loadNamespace: async () => ({ default: input.channel }), logicalPath: "channels/chat.ts" },
    ...(input.modules ?? []),
  ];
  const app = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({
          model: mockModel(input.respond ?? "Hi Alice."),
          modelContextWindowTokens: 200_000,
        })),
        experimental: { workflow: { modelCallsPerStep: 4 } },
      }),
      limits: { sessionTimeoutMs: false },
      name: input.name,
    },
    modules,
  });
  await app.run(async () => {
    const token = `channel:chat:${input.name}`;
    const run = await startTestSession("in-process", {
      input: { message: "Alice: hello" },
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      serializedContext: buildSerializedContext({
        channelKind: "channel:chat",
        continuationToken: token,
      }),
    });
    const stream = captureTurnEvents(run);
    try {
      await stream.nextTurn();
      for (const message of input.then ?? []) {
        await resumeRoutedHook(sessionInboxHookToken(token), {
          delivery: createChannelDeliveryMetadata({
            channelKind: "channel:chat",
            channelName: "chat",
          }),
          kind: "send",
          payload: { message },
        });
        await stream.nextTurn();
      }
    } finally {
      stream.dispose();
      await run.cancel().catch(() => {});
    }
  });
}

describe("channel event delivery", () => {
  it("holds the model for a handler, and drains its waitUntil work at the end of each model call", async () => {
    const seen: string[] = [];
    let runs = 0;
    const channel = defineChannel<{ background: number }, { state: { background: number } }>({
      context: (state) => ({ state }),
      routes,
      state: { background: 0 },
      events: {
        async "turn.started"(_event, { channel }) {
          await platformCall();
          seen.push(`turn.started, after ${channel.state.background} background`);
        },
        "model.started"(_event, ctx) {
          const run = ++runs;
          seen.push(`model.started ${run}`);
          ctx.waitUntil(
            (async () => {
              await platformCall();
              ctx.channel.state.background += 1;
              seen.push(`background ${run}`);
            })(),
          );
        },
      },
    });
    const lookup = defineTool({
      description: "Look up the forecast.",
      inputSchema: z.object({}),
      execute: async () => {
        seen.push("tool");
        return { forecast: "sunny" };
      },
    });

    await converse({
      name: "channel-wait-until",
      channel,
      modules: [
        { loadNamespace: async () => ({ default: lookup }), logicalPath: "tools/lookup.ts" },
      ],
      respond: ({ lastUserMessage, toolResults }) =>
        lastUserMessage === "Alice: hello" && toolResults.length === 0
          ? { toolCalls: [{ name: "lookup" }] }
          : "Sunny.",
      then: ["Alice: thanks"],
    });

    expect(seen).toEqual([
      "turn.started, after 0 background",
      "model.started 1",
      "tool",
      "background 1",
      "model.started 2",
      "background 2",
      "turn.started, after 2 background",
      "model.started 3",
      "background 3",
    ]);
  }, 60_000);

  it("drains a cancelled turn's waitUntil work before its checkpoint", async () => {
    const seen: string[] = [];
    const channel = defineChannel<{ marks: string[] }, { state: { marks: string[] } }>({
      context: (state) => ({ state }),
      routes,
      state: { marks: [] },
      events: {
        "turn.started"(event, ctx) {
          seen.push(`${event.data.turnId} started after [${ctx.channel.state.marks.join(", ")}]`);
          ctx.waitUntil(
            (async () => {
              await platformCall();
              ctx.channel.state.marks = [...ctx.channel.state.marks, event.data.turnId];
            })(),
          );
        },
      },
    });
    let admitted = 0;
    const stop = defineHook({
      events: {
        "delivery.admitted"(_event, ctx) {
          if (++admitted === 2) ctx.cancel();
        },
      },
    });

    await converse({
      name: "channel-wait-until-cancel",
      channel,
      modules: [{ loadNamespace: async () => ({ default: stop }), logicalPath: "hooks/stop.ts" }],
      then: ["Alice: never mind", "Alice: still there?"],
    });

    expect(seen).toEqual([
      "turn_0 started after []",
      "turn_1 started after [turn_0]",
      "turn_2 started after [turn_0, turn_1]",
    ]);
  }, 60_000);

  it("logs a failed waitUntil promise without failing the turn", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const settled: string[] = [];
    const channel = defineChannel({
      routes,
      events: {
        "turn.started"(_event, ctx) {
          ctx.waitUntil(Promise.reject(new Error("The status update was rate limited.")));
        },
        "turn.settled"(event) {
          settled.push(event.data.outcome);
        },
      },
    });

    await converse({ name: "channel-wait-until-failure", channel, then: ["Alice: thanks"] });

    expect(settled).toEqual(["completed", "completed"]);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("a channel event handler's waitUntil work failed"),
      expect.objectContaining({ eventType: "turn.started" }),
    );
  }, 60_000);

  it("does not block the first model call on delivery.admitted waitUntil work", async () => {
    const admittedGate = Promise.withResolvers<void>();
    const admittedStarted = Promise.withResolvers<void>();
    const order: string[] = [];
    const channel = defineChannel<{ done: boolean }, { state: { done: boolean } }>({
      context: (state) => ({ state }),
      routes,
      state: { done: false },
      events: {
        "delivery.admitted"(_event, ctx) {
          ctx.waitUntil(
            (async () => {
              order.push("admitted.start");
              admittedStarted.resolve();
              await admittedGate.promise;
              ctx.channel.state.done = true;
              order.push("admitted.done");
            })(),
          );
        },
        "turn.settled"(_event, ctx) {
          order.push(`settled:${String(ctx.channel.state.done)}`);
        },
      },
    });

    await converse({
      name: "channel-admitted-wait-until-nonblocking",
      channel,
      respond: () => {
        order.push("model");
        admittedGate.resolve();
        return "Hi Alice.";
      },
    });

    await admittedStarted.promise;
    expect(order.indexOf("model")).toBeLessThan(order.indexOf("admitted.done"));
    expect(order).toContain("admitted.done");
  }, 60_000);
});
