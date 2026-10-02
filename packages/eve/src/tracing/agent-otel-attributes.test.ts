import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ConversationIdKey, TraceRootKey } from "#context/keys.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agentTraceIdentityAttributes", () => {
  it("uses the lineage fallback when a remote entry has no conversation in context", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const context = new ContextContainer();
    context.set(TraceRootKey, { kind: "own" });
    contextStorage.run(context, () => {
      expect(
        agentTraceIdentityAttributes({
          rootSessionId: "caller-root",
          sessionId: "remote-session",
          traceSessionId: "remote-session",
        }),
      ).toMatchObject({
        "gen_ai.conversation.id": "caller-root",
        "vercel.session_id": "remote-session",
        "agent.run.id": "remote-session",
      });
    });
  });
  const input = {
    rootSessionId: "root-session",
    sessionId: "session-1",
    traceSessionId: "root-session",
  };
  it("uses the explicit trace session when active context belongs to another session", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const context = new ContextContainer();
    context.set(TraceRootKey, { kind: "inherited", sessionId: "unrelated-session" });
    contextStorage.run(context, () => {
      expect(
        agentTraceIdentityAttributes({
          rootSessionId: "caller-root",
          sessionId: "remote",
          traceSessionId: "remote",
        })["vercel.session_id"],
      ).toBe("remote");
    });
  });

  it("uses the GenAI conversation identifier outside Vercel", () => {
    vi.stubEnv("VERCEL_ENV", undefined);

    expect(agentTraceIdentityAttributes(input)).toEqual({
      "agent.run.id": "session-1",
      "agent.trace.schema.version": 4,
      "gen_ai.conversation.id": "root-session",
    });
  });

  it("adds the Vercel session identifier on Vercel", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const context = new ContextContainer();
    context.set(ConversationIdKey, "caller-conversation");

    contextStorage.run(context, () => {
      expect(agentTraceIdentityAttributes(input)).toEqual({
        "agent.run.id": "session-1",
        "agent.trace.schema.version": 4,
        "gen_ai.conversation.id": "caller-conversation",
        "vercel.session_id": "root-session",
      });
    });
  });
});
