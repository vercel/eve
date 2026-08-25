import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { instrumentChannelDelivery } from "#harness/channel-delivery-instrumentation.js";
import { bindSessionInstrumentation } from "#instrumentation/bind-session.js";
import {
  createInstrumentationHooks,
  type InstrumentationEvent,
} from "#instrumentation/lifecycle.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import { planSessionInstrumentation } from "#instrumentation/session-plan.js";

describe("channel delivery instrumentation", () => {
  it("projects only known content and redacts it from metadata providers", async () => {
    const content: InstrumentationEvent[] = [];
    const metadata: InstrumentationEvent[] = [];
    const hooks = createInstrumentationHooks([
      {
        capture: "content",
        events: {
          "channel.delivery.started": (event) => {
            content.push(event);
          },
        },
        name: "content",
      },
      {
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
    const runtime: InstrumentationRuntime = {
      forceFlush: async () => undefined,
      hooks,
      otelSettings: undefined,
      runInContext: (_operation, execute) => execute(),
      shutdown: async () => undefined,
    };
    const plan = planSessionInstrumentation({
      runtime,
      session: {
        agentName: "test-agent",
        channel: {
          kind: "channel:slack",
          metadata: { audience: "public" },
        },
        parentTraceContext,
        rootSessionId: "session-1",
      },
    });
    const instrumentation = bindSessionInstrumentation({
      plan,
      rootSessionId: "session-1",
      runtime,
      sessionId: "session-1",
    });

    await contextStorage.run(ctx, async () => {
      await instrumentChannelDelivery({
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
        instrumentation,
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn_0",
      });
      await instrumentChannelDelivery({
        ctx,
        instrumentation,
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
});
