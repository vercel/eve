import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunInput, SessionAuthContext } from "#channel/types.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import { buildConversationContext } from "#channel/conversation-context.js";
import {
  ConversationContextKey,
  UNKNOWN_CONVERSATION_CONTEXT,
} from "#shared/conversation-context.js";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

function run(input: Partial<RunInput>): RunInput {
  return {
    adapter: { kind: "http" },
    auth: null,
    input: { message: "hello" },
    mode: "conversation",
    ...input,
  };
}

describe("resolveInstrumentationEnvironment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves development, preview, and production", () => {
    vi.stubEnv("EVE_DEV", "1");
    expect(resolveInstrumentationEnvironment()).toBe("development");

    vi.stubEnv("EVE_DEV", "0");
    vi.stubEnv("VERCEL_ENV", "development");
    expect(resolveInstrumentationEnvironment()).toBe("development");

    vi.stubEnv("VERCEL_ENV", "preview");
    expect(resolveInstrumentationEnvironment()).toBe("preview");

    vi.stubEnv("VERCEL_ENV", "production");
    expect(resolveInstrumentationEnvironment()).toBe("production");
  });
});

describe("buildConversationContext", () => {
  it("classifies through the channel audience hook", () => {
    const context = buildConversationContext(
      run({
        adapter: {
          kind: "http",
          instrumentation: {
            audience: () => "private",
          },
        },
        auth,
      }),
      "preview",
    );

    expect(context).toEqual({
      audience: "private",
      channel: { kind: "http", name: undefined },
      environment: "preview",
      mode: "conversation",
      principalType: "user",
    });
  });

  it("uses the path-derived channel kind for authored channels", () => {
    const context = buildConversationContext(
      run({ adapter: { kind: "slack" }, channelName: "support" }),
      "production",
    );

    expect(context.channel).toEqual({ kind: "channel:support", name: "support" });
    expect(context.audience).toBe("unknown");
  });

  it("classifies from route authentication separately from session auth", () => {
    const context = buildConversationContext(
      run({
        adapter: {
          kind: "http",
          instrumentation: {
            audience: ({ auth }) => (auth?.principalType === "user" ? "private" : "public"),
          },
        },
        audienceAuth: auth,
        auth: null,
      }),
      "production",
    );

    expect(context).toMatchObject({ audience: "private", principalType: "user" });
  });

  it("inherits the parent audience for local subagents", () => {
    const context = buildConversationContext(
      run({
        adapter: { kind: "subagent" },
        inheritedConversation: {
          audience: "public",
          channel: { kind: "channel:slack", name: "slack" },
          environment: "production",
          mode: "conversation",
          principalType: "user",
        },
        mode: "task",
      }),
      "production",
    );

    expect(context).toMatchObject({ audience: "public", channel: { kind: "subagent" } });
  });

  it("lets a trusted forwarded origin win over local classification", () => {
    const context = buildConversationContext(
      run({
        adapter: {
          kind: "eve",
          instrumentation: { audience: () => "public" },
        },
        parentTraceContext: {
          forwardedTracePolicy: {
            ceiling: { recordInputs: false, recordOutputs: true },
            originAudience: "private",
          },
          spanId: "1".repeat(16),
          traceFlags: 1,
          traceId: "2".repeat(32),
        },
      }),
      "production",
    );

    expect(context.audience).toBe("private");
  });
});

describe("ConversationContextKey", () => {
  it("round-trips a valid context and fails malformed projections closed", () => {
    const context = buildConversationContext(run({ auth }), "production");

    expect(ConversationContextKey.codec?.deserialize(context, new Map() as never)).toEqual(context);
    expect(
      ConversationContextKey.codec?.deserialize({ audience: "public" }, new Map() as never),
    ).toEqual(UNKNOWN_CONVERSATION_CONTEXT);
  });

  it("keeps audience out of the durable channel adapter wire shape", () => {
    const serialized = ChannelKey.codec?.serialize({
      kind: "http",
      instrumentation: { metadata: () => ({ audience: "public", custom: "value" }) },
    });

    expect(serialized).toEqual({ kind: "http", state: {} });
  });
});
