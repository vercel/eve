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
import { ConversationContextKey, type ConversationContext } from "#shared/conversation-context.js";

function setConversation(
  ctx: ContextContainer,
  audience: "public" | "private",
  kind: ConversationContext["channel"]["kind"] = "channel:slack",
): void {
  ctx.set(ChannelInstrumentationKey, { kind, metadata: {} });
  ctx.set(ConversationContextKey, {
    audience,
    channel: { kind, name: "slack" },
    environment: "production",
    mode: "conversation",
    principalType: "anonymous",
  });
}

function bindHooks(
  hooks: InstrumentationRuntime["hooks"],
  ctx: ContextContainer,
  agentName = "test-agent",
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
    setConversation(ctx, "public");
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
    setConversation(ctx, "private");
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
    setConversation(ctx, "public");
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
      setConversation(ctx, "private");
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
      channel: { kind: "channel:slack", name: "slack" },
      environment: "production",
      mode: "conversation",
      principalType: "anonymous",
    });
  });

  it("terminates every distinct delivery admitted before the turn completes", async () => {
    const started = vi.fn();
    const completed = vi.fn();
    const hooks = createInstrumentationHooks([
      {
        events: {
          "channel.delivery.completed": completed,
          "channel.delivery.started": started,
        },
        name: "delivery-lifecycle",
        tracePolicy: () => true,
      },
    ]);
    const ctx = new ContextContainer();
    setConversation(ctx, "private");
    const instrumentation = bindHooks(hooks, ctx);
    const delivery = (deliveryId: string, message: string) => ({
      deliveryMetadata: [
        {
          channelKind: "channel:slack" as const,
          channelName: "slack",
          deliveryId,
          payloadIndex: 0,
        },
      ],
      kind: "deliver" as const,
      payloads: [{ message }],
    });

    await contextStorage.run(ctx, async () => {
      for (const value of [
        delivery("delivery-original", "Read Alice's report."),
        delivery("delivery-steering", "Actually, use the 2025 report."),
        delivery("delivery-steering", "Actually, use the 2025 report."),
      ]) {
        await instrumentation?.instrumentChannelDelivery({
          ctx,
          delivery: value,
          rootSessionId: "session-1",
          sequence: 0,
          sessionId: "session-1",
          turnId: "turn_0",
        });
      }
      await instrumentation?.instrumentChannelDelivery({
        ctx,
        includeTurn: true,
        outcome: "completed",
      });
    });

    expect(started).toHaveBeenCalledTimes(2);
    expect(completed).toHaveBeenCalledTimes(2);
    expect(completed.mock.calls.map(([event]) => event.delivery.deliveryId).sort()).toEqual([
      "delivery-original",
      "delivery-steering",
    ]);
  });
});
