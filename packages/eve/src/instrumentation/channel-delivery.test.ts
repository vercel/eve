import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ChannelInstrumentationKey, ParentTraceContextKey } from "#context/keys.js";
import {
  createInstrumentationHooks,
  type InstrumentationEvent,
} from "#instrumentation/lifecycle.js";
import {
  bindInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#instrumentation/runtime.js";

function bindHooks(
  hooks: InstrumentationRuntime["hooks"],
  ctx: ContextContainer,
  agentName?: string,
) {
  return bindInstrumentationRuntime(
    {
      forceFlush: async () => undefined,
      hooks,
      otelSettings: undefined,
      runInContext: (_operation, execute) => execute(),
      shutdown: async () => undefined,
    },
    ctx,
    { agentName, rootSessionId: "session-1", sessionId: "session-1" },
  );
}

describe("channel delivery instrumentation", () => {
  it("projects only known content and redacts it from metadata providers", async () => {
    const content: InstrumentationEvent[] = [];
    const metadata: InstrumentationEvent[] = [];
    const hooks = createInstrumentationHooks([
      {
        tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
        events: {
          "channel.delivery.started": (event) => {
            content.push(event);
          },
        },
        name: "content",
      },
      {
        tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
        events: {
          "channel.delivery.started": (event) => {
            metadata.push(event);
          },
        },
        name: "metadata",
      },
    ]);
    const ctx = new ContextContainer();
    const parentTraceContext = {
      isRemote: true,
      spanId: "2222222222222222",
      traceFlags: 1,
      traceId: "11111111111111111111111111111111",
    };
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:slack",
      metadata: { audience: "public" },
    });
    ctx.set(ParentTraceContextKey, parentTraceContext);
    const instrumentation = bindHooks(hooks, ctx);

    await contextStorage.run(ctx, async () => {
      await instrumentation?.instrumentChannelDelivery({
        ctx,
        delivery: {
          deliveryMetadata: [
            {
              channelKind: "channel:slack",
              channelName: "slack",
              deliveryId: "delivery-1",
              payloadIndex: 0,
            },
          ],
          kind: "deliver",
          payloads: [{ interaction: { secret: true }, message: "hello" }],
        },
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn_0",
      });
      await instrumentation?.instrumentChannelDelivery({
        ctx,
        includeTurn: true,
        outcome: "completed",
      });
    });

    expect(content[0]).toMatchObject({ input: { message: "hello" }, parentTraceContext });
    expect((content[0] as { input?: Record<string, unknown> }).input).not.toHaveProperty(
      "interaction",
    );
    expect(metadata[0]).toMatchObject({ input: undefined });
  });

  it("keeps provider content independent from the OTel audience ceiling", async () => {
    const events: InstrumentationEvent[] = [];
    const hooks = createInstrumentationHooks([
      {
        tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
        events: {
          "channel.delivery.started": (event) => {
            events.push(event);
          },
        },
        name: "content",
      },
    ]);
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:slack",
      metadata: { audience: "private" },
    });
    const instrumentation = bindHooks(hooks, ctx);
    await contextStorage.run(ctx, () =>
      instrumentation?.instrumentChannelDelivery({
        ctx,
        delivery: {
          deliveryMetadata: [
            {
              channelKind: "channel:slack",
              channelName: "slack",
              deliveryId: "delivery-1",
              payloadIndex: 0,
            },
          ],
          kind: "deliver",
          payloads: [{ message: "secret" }],
        },
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn_0",
      }),
    );

    expect(events[0]).toMatchObject({ input: { message: "secret" } });
  });

  it("uses delivery-start context when a bound turn publishes the terminal", async () => {
    const completed = vi.fn();
    const tracePolicy = vi.fn(({ audience }) => audience === "public");
    const hooks = createInstrumentationHooks([
      {
        events: { "channel.delivery.completed": completed },
        name: "public-only",
        tracePolicy,
      },
    ]);
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, {
      channelType: "slack",
      kind: "channel:slack",
      metadata: { audience: "public" },
    });
    const instrumentation = bindHooks(hooks, ctx, "Weather Display Name");

    await contextStorage.run(ctx, async () => {
      await instrumentation?.instrumentChannelDelivery({
        agentName: "weather",
        ctx,
        delivery: {
          deliveryMetadata: [
            {
              channelKind: "channel:slack",
              channelName: "slack",
              deliveryId: "delivery-1",
              payloadIndex: 0,
            },
          ],
          kind: "deliver",
          payloads: [{ message: "hello" }],
        },
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn_0",
      });
      ctx.set(ChannelInstrumentationKey, {
        channelType: "slack",
        kind: "channel:slack",
        metadata: { audience: "private" },
      });
      await instrumentation?.instrumentChannelDelivery({
        ctx,
        includeTurn: true,
        outcome: "completed",
      });
    });

    expect(completed).toHaveBeenCalledOnce();
    expect(completed.mock.calls[0]?.[0].agentName).toBe("weather");
    expect(tracePolicy.mock.calls[0]?.[0]).toEqual({
      agentName: "Weather Display Name",
      audience: "public",
      channelType: "slack",
    });
  });
});
