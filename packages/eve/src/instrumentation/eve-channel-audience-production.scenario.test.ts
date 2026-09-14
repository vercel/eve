import { afterEach, describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import type { RunInput, SessionAuthContext } from "#channel/types.js";
import { eveChannel } from "#eve-channel/index.js";
import {
  modelCallIdempotencyKey,
  sessionIdempotencyKey,
  type InstrumentationEvent,
} from "#instrumentation/lifecycle.js";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
  seedInstrumentationProviders,
} from "#instrumentation/providers.js";
import { none } from "#public/channels/auth.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { buildConversationContext } from "#channel/conversation-context.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("eve channel production audience", () => {
  it("classifies callers and captures content only for public sessions", async () => {
    vi.stubEnv("EVE_DEV_WORKER_APP_ROOT", undefined);
    vi.stubEnv("VERCEL_ENV", "production");

    const events: InstrumentationEvent[] = [];
    seedInstrumentationProviders();
    await registerInstrumentationProvider({
      agentName: "weather",
      slot: "audit",
      value: defineInstrumentation({
        events: {
          "model.call.started": (event) => {
            events.push(event);
          },
          "session.started": (event) => {
            events.push(event);
          },
        },
      }),
    });
    const runtime = finalizeInstrumentationProviders({ serviceName: "weather" });
    const channel = eveChannel({ auth: none() });
    if (!isCompiledChannel(channel)) throw new Error("Expected a compiled eve channel.");

    const user: SessionAuthContext = {
      attributes: {},
      authenticator: "test",
      principalId: "user-1",
      principalType: "user",
    };
    const conversationFor = (auth: SessionAuthContext | null) =>
      buildConversationContext(
        {
          adapter: channel.adapter,
          auth,
          input: { message: "private message" },
          mode: "conversation",
        } satisfies RunInput,
        "production",
      );

    for (const conversation of [conversationFor(null), conversationFor(user)]) {
      const hooks = runtime.hooks.forTrace!({ agentName: "weather", ...conversation });
      await hooks.publish({
        channelAudience: conversation.audience,
        channelKind: conversation.channel.kind,
        idempotencyKey: sessionIdempotencyKey(`session-${conversation.audience}`),
        rootSessionId: `session-${conversation.audience}`,
        sessionId: `session-${conversation.audience}`,
        type: "session.started",
      });
      await hooks.publish({
        idempotencyKey: modelCallIdempotencyKey(
          {
            attemptId: `session-${conversation.audience}:turn-1:0:0`,
            attemptIndex: 0,
            sessionId: `session-${conversation.audience}`,
            stepIndex: 0,
            turnId: "turn-1",
          },
          0,
        ),
        input: { instructions: "private instructions", messages: [] },
        model: { modelId: "test", provider: "test" },
        scope: {
          attemptId: `session-${conversation.audience}:turn-1:0:0`,
          attemptIndex: 0,
          channelAudience: conversation.audience,
          sessionId: `session-${conversation.audience}`,
          stepIndex: 0,
          turnId: "turn-1",
        },
        type: "model.call.started",
      });
    }

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ channelAudience: "public", type: "session.started" });
    expect(events[1]).toMatchObject({
      input: { instructions: "private instructions" },
      type: "model.call.started",
    });
    expect(events[2]).toMatchObject({ channelAudience: "private", type: "session.started" });
    expect(events[3]).toMatchObject({ input: undefined, type: "model.call.started" });

    await runtime.forceFlush();
    await runtime.shutdown();
  });
});
