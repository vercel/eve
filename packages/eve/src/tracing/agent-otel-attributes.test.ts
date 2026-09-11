import { afterEach, describe, expect, it, vi } from "vitest";

import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agentTraceIdentityAttributes", () => {
  const input = { rootSessionId: "conversation-1", sessionId: "session-1" };

  it("uses the GenAI conversation identifier outside Vercel", () => {
    vi.stubEnv("VERCEL_ENV", undefined);

    expect(agentTraceIdentityAttributes(input)).toEqual({
      "agent.trace.schema.version": 4,
      "gen_ai.conversation.id": "conversation-1",
    });
  });

  it("adds the Vercel session identifier on Vercel", () => {
    vi.stubEnv("VERCEL_ENV", "preview");

    expect(agentTraceIdentityAttributes(input)).toEqual({
      "agent.trace.schema.version": 4,
      "gen_ai.conversation.id": "conversation-1",
      "vercel.session_id": "session-1",
    });
  });
});
