import { describe, expect, it } from "vitest";

import {
  createSession,
  hydrateDurableSession,
  mintSubagentContinuationToken,
  projectToDurableSession,
} from "#execution/session.js";

describe("createSession", () => {
  it("starts with empty history and stores the continuation token verbatim", () => {
    const session = createSession({ continuationToken: "root-token", sessionId: "sess-root" });

    expect(session.history).toEqual([]);
    expect(session.continuationToken).toBe("root-token");
  });

  it("starts with a copy of the agent's initial messages", () => {
    const initialMessages = [
      { content: "Pinned tenant policy.", kind: "user" as const, role: "user" as const },
    ];
    const session = createSession({
      continuationToken: "root-token",
      initialMessages,
      sessionId: "sess-root",
    });
    initialMessages[0] = { content: "mutated", kind: "user" as const, role: "user" };

    expect(session.history).toEqual([
      { content: "Pinned tenant policy.", kind: "user", role: "user" },
    ]);
  });
});

describe("durable sessions", () => {
  it("keeps the run's outputSchema and the delegated root lineage", () => {
    const outputSchema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;
    const session = createSession({
      continuationToken: "subagent-token",
      outputSchema,
      rootSessionId: "sess-root",
      sessionId: "sess-child",
    });

    const hydrated = hydrateDurableSession(structuredClone(projectToDurableSession(session)));

    expect(hydrated.outputSchema).toEqual(outputSchema);
    expect(hydrated.rootSessionId).toBe("sess-root");
  });

  it("keeps what compaction last measured", () => {
    const session = {
      ...createSession({ continuationToken: "root-token", sessionId: "sess-root" }),
      compaction: {
        lastKnownInputTokens: 321,
        lastKnownPromptMessageCount: 7,
        requestEnvelopeTokens: 42,
      },
    };

    const durable = projectToDurableSession(session);

    expect(hydrateDurableSession(structuredClone(durable)).compaction).toEqual(session.compaction);
    expect(projectToDurableSession(createSession(session))).not.toHaveProperty("compaction");
  });
});

describe("mintSubagentContinuationToken", () => {
  it("prefixes the token with 'subagent:'", () => {
    expect(mintSubagentContinuationToken()).toMatch(/^subagent:/);
  });

  it("returns a unique token on each call", () => {
    expect(mintSubagentContinuationToken()).not.toBe(mintSubagentContinuationToken());
  });
});
