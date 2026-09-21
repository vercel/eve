import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ConversationIdKey } from "#context/keys.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agentTraceIdentityAttributes", () => {
  const input = { rootSessionId: "root-session", sessionId: "session-1" };

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
