import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { defineDynamic } from "#dynamic/definition.js";
import { mockModel } from "#evals/mock-model.js";
import { createInitialSessionValues } from "#execution/initial-session-values.js";
import { stampSessionIdentity } from "#execution/session/owner-boot.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import type { EveAttributeValue } from "#runtime/attributes/normalize.js";
import { defineTool } from "#tools/definition.js";

const routes = [POST("/messages", async () => new Response(null, { status: 204 }))];

function createSinkWritable(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write() {},
  });
}

async function drainPendingTurns(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
}

function createTurnStepInput(sessionId: string, message: string, channelKind = "channel:chat") {
  const continuationToken = `${channelKind}:${sessionId}`;
  const initial = createInitialSessionValues({ continuationToken, sessionId });
  return {
    history: initial.history,
    input: {
      delivery: {
        deliveryMetadata: [
          {
            ...createChannelDeliveryMetadata({
              channelKind,
              channelName: "chat",
            }),
            payloadIndex: 0,
          },
        ],
        kind: "deliver" as const,
        payloads: [{ message }],
      },
    },
    serializedContext: stampSessionIdentity(
      buildSerializedContext({
        channelKind,
        continuationToken,
      }),
      sessionId,
    ),
    sessionState: initial.state,
    sessionWritable: createSinkWritable(),
  };
}

function createStepHost(setAttributes: SessionStepHost["setAttributes"]): SessionStepHost {
  return {
    createRuntime: () => {
      throw new Error("Unexpected createRuntime call in turnStepOn usage test");
    },
    setAttributes,
  };
}

describe("turnStepOn usage attributes", () => {
  it("coalesces a multi-call step into one usage write overlapping channel drain and waits before returning", async () => {
    const drainStarted = Promise.withResolvers<void>();
    const drainGate = Promise.withResolvers<void>();
    const usageStarted = Promise.withResolvers<void>();
    const usageGate = Promise.withResolvers<void>();

    const usageWrites: Array<Record<string, EveAttributeValue>> = [];
    let toolCalls = 0;
    let usageWritesBeforeSecondCall: number | undefined;

    const lookup = defineTool({
      description: "Look up an item",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        toolCalls += 1;
        return { found: id };
      },
    });

    const channel = defineChannel({
      routes,
      events: {
        "turn.settled"(_event, ctx) {
          ctx.waitUntil(
            (async () => {
              drainStarted.resolve();
              await drainGate.promise;
            })(),
          );
        },
      },
    });

    const app = await createTestRuntime({
      agent: {
        definition: defineAgent({
          experimental: { workflow: { modelCallsPerStep: 4 } },
          model: defineDynamic(() => ({
            model: mockModel(({ toolResults }) => {
              if (toolResults.length === 0) {
                return {
                  toolCalls: [{ id: "call-1", input: { id: "a" }, name: "lookup" }],
                  usage: { inputTokens: 10, outputTokens: 5 },
                };
              }
              usageWritesBeforeSecondCall = usageWrites.length;
              return {
                text: "Done.",
                usage: { inputTokens: 20, outputTokens: 8 },
              };
            }),
            modelContextWindowTokens: 200_000,
          })),
        }),
        name: "usage-coalesce-multi-call",
      },
      modules: [
        { loadNamespace: async () => ({ default: channel }), logicalPath: "channels/chat.ts" },
        { loadNamespace: async () => ({ default: lookup }), logicalPath: "tools/lookup.ts" },
      ],
    });

    await app.run(async () => {
      const runStep = turnStepOn(
        createStepHost(async (attributes) => {
          if ("$eve.input_tokens" in attributes) {
            usageWrites.push(attributes);
            usageStarted.resolve();
            await usageGate.promise;
          }
        }),
      );

      let settled = false;
      const stepPromise = runStep(createTurnStepInput("sess-multi-call", "Look it up.")).then(
        (result) => {
          settled = true;
          return result;
        },
      );

      try {
        await drainStarted.promise;
        await usageStarted.promise;

        expect(toolCalls).toBe(1);
        expect(usageWritesBeforeSecondCall).toBe(0);
        expect(usageWrites).toHaveLength(1);
        expect(usageWrites[0]).toMatchObject({
          "$eve.input_tokens": 30,
          "$eve.model": "eve-mock/model",
          "$eve.output_tokens": 13,
        });
        expect(usageWrites[0]?.["$eve.tool_count"]).toBeGreaterThanOrEqual(1);

        drainGate.resolve();
        await drainPendingTurns();
        expect(settled).toBe(false);

        usageGate.resolve();
        const result = await stepPromise;
        expect(result.action).toBe("parked");
        expect(usageWrites).toHaveLength(1);
      } finally {
        drainGate.resolve();
        usageGate.resolve();
        await stepPromise.catch(() => undefined);
      }
    });
  });

  it("starts a single-call step's usage write before turn settlement finishes and without waiting on title", async () => {
    const settleStarted = Promise.withResolvers<void>();
    const settleGate = Promise.withResolvers<void>();
    const titleGate = Promise.withResolvers<void>();
    const usageStarted = Promise.withResolvers<void>();
    const usageGate = Promise.withResolvers<void>();

    const titleWrites: Array<Record<string, EveAttributeValue>> = [];
    const usageWrites: Array<Record<string, EveAttributeValue>> = [];

    const channel = defineChannel({
      routes,
      events: {
        async "turn.settled"() {
          settleStarted.resolve();
          await settleGate.promise;
        },
      },
    });

    const app = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({
            model: mockModel(() => ({
              text: "Hello.",
              usage: { inputTokens: 7, outputTokens: 3 },
            })),
            modelContextWindowTokens: 200_000,
          })),
        }),
        name: "usage-overlap-single-call",
      },
      modules: [
        { loadNamespace: async () => ({ default: channel }), logicalPath: "channels/chat.ts" },
      ],
    });

    await app.run(async () => {
      const runStep = turnStepOn(
        createStepHost(async (attributes) => {
          if ("$eve.title" in attributes) {
            titleWrites.push(attributes);
            await titleGate.promise;
            return;
          }
          if ("$eve.input_tokens" in attributes) {
            usageWrites.push(attributes);
            usageStarted.resolve();
            await usageGate.promise;
          }
        }),
      );

      let settled = false;
      const stepPromise = runStep(createTurnStepInput("sess-single-call", "Say hi.")).then(
        (result) => {
          settled = true;
          return result;
        },
      );

      try {
        await settleStarted.promise;
        await usageStarted.promise;

        expect(titleWrites).toHaveLength(1);
        expect(usageWrites).toHaveLength(1);
        expect(usageWrites[0]).toMatchObject({
          "$eve.input_tokens": 7,
          "$eve.model": "eve-mock/model",
          "$eve.output_tokens": 3,
        });

        settleGate.resolve();
        await drainPendingTurns();
        expect(settled).toBe(false);

        titleGate.resolve();
        await drainPendingTurns();
        expect(settled).toBe(false);

        usageGate.resolve();
        const result = await stepPromise;
        expect(result.action).toBe("parked");
        expect(usageWrites).toHaveLength(1);
      } finally {
        settleGate.resolve();
        titleGate.resolve();
        usageGate.resolve();
        await stepPromise.catch(() => undefined);
      }
    });
  });

  it("flushes earlier call usage when a later call in the batch cancels without waiting behind title", async () => {
    const titleGate = Promise.withResolvers<void>();
    const usageStarted = Promise.withResolvers<void>();
    const usageGate = Promise.withResolvers<void>();
    const abortController = new AbortController();

    const usageWrites: Array<Record<string, EveAttributeValue>> = [];
    let modelCalls = 0;

    const lookup = defineTool({
      description: "Look up an item",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ found: id }),
    });

    const channel = defineChannel({
      routes,
      events: {
        "turn.started"() {},
      },
    });

    const app = await createTestRuntime({
      agent: {
        definition: defineAgent({
          experimental: { workflow: { modelCallsPerStep: 4 } },
          model: defineDynamic(() => ({
            model: mockModel(() => {
              modelCalls += 1;
              if (modelCalls === 1) {
                return {
                  toolCalls: [{ id: "call-1", input: { id: "a" }, name: "lookup" }],
                  usage: { inputTokens: 12, outputTokens: 4 },
                };
              }
              abortController.abort();
              return {
                text: "Cancelled before finishing.",
                usage: { inputTokens: 99, outputTokens: 99 },
              };
            }),
            modelContextWindowTokens: 200_000,
          })),
        }),
        name: "usage-flush-on-cancel",
      },
      modules: [
        { loadNamespace: async () => ({ default: channel }), logicalPath: "channels/chat.ts" },
        { loadNamespace: async () => ({ default: lookup }), logicalPath: "tools/lookup.ts" },
      ],
    });

    await app.run(async () => {
      const runStep = turnStepOn(
        createStepHost(async (attributes) => {
          if ("$eve.title" in attributes) {
            await titleGate.promise;
            return;
          }
          if ("$eve.input_tokens" in attributes) {
            usageWrites.push(attributes);
            usageStarted.resolve();
            await usageGate.promise;
          }
        }),
      );

      let settled = false;
      const stepPromise = runStep({
        ...createTurnStepInput("sess-cancel-batch", "Cancel mid-batch."),
        abortSignal: abortController.signal,
      }).then((result) => {
        settled = true;
        return result;
      });

      try {
        await usageStarted.promise;
        expect(usageWrites).toHaveLength(1);
        expect(usageWrites[0]).toMatchObject({
          "$eve.input_tokens": 12,
          "$eve.output_tokens": 4,
        });

        titleGate.resolve();
        await drainPendingTurns();
        expect(settled).toBe(false);

        usageGate.resolve();
        const result = await stepPromise;
        expect(result.action).toBe("cancelled");
        expect(usageWrites).toHaveLength(1);
      } finally {
        titleGate.resolve();
        usageGate.resolve();
        await stepPromise.catch(() => undefined);
      }
    });
  });
});
