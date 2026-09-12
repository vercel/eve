import { describe, expect, it } from "vitest";
import type { HarnessSession } from "#harness/types.js";
import {
  createDurableSessionState,
  DURABLE_SESSION_VERSION,
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { projectToDurableSession } from "#execution/session.js";

describe("durable session checkpoints", () => {
  it("embeds the durable session and its workflow projections together", () => {
    const session = buildSession({
      sessionId: "session",
      continuationToken: "alias",
      withRefreshableAgent: true,
    });
    const state = createDurableSessionState({ session });
    expect(state).toEqual({
      sessionId: "session",
      continuationToken: "alias",
      version: DURABLE_SESSION_VERSION,
      hasProxyInputRequests: false,
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
      snapshot: { session: projectToDurableSession(session) },
    });
    expect(readDurableSession(state)).toBe(state.snapshot.session);
    expect(state.snapshot.session.agent).toEqual({ system: "test system" });
  });

  it("refreshes projections when replacing session program memory", () => {
    const state = createDurableSessionState({
      session: buildSession({ sessionId: "session", continuationToken: "old" }),
    });
    const session = { ...readDurableSession(state), continuationToken: "new" };
    const replaced = replaceDurableSessionSnapshot({ session, state });
    expect(replaced.continuationToken).toBe("new");
    expect(readDurableSession(replaced)).toBe(session);
    expect(state.continuationToken).toBe("old");
  });

  it.each([{ version: 2, snapshot: { session: {} } }, { version: 1 }])(
    "rejects unsupported checkpoints without a storage fallback",
    (state) => {
      expect(() => readDurableSession(state as DurableSessionState)).toThrow(
        "Unsupported session checkpoint",
      );
    },
  );
});

function buildSession(input: {
  sessionId: string;
  continuationToken: string;
  withRefreshableAgent?: boolean;
}): HarnessSession {
  return {
    agent: {
      compactionModelReference: input.withRefreshableAgent
        ? { id: "compaction-model", contextWindowTokens: 200_000 }
        : undefined,
      modelReference: { id: "test-model", contextWindowTokens: 200_000 },
      system: "test system",
      tools: input.withRefreshableAgent
        ? [{ description: "", inputSchema: { type: "object" }, name: "test" }]
        : [],
    },
    compaction: {
      lastKnownInputTokens: 100,
      lastKnownPromptMessageCount: 3,
      recentWindowSize: 10,
      threshold: 180_000,
    },
    continuationToken: input.continuationToken,
    history: [{ content: "hi", kind: "user", role: "user" }],
    sessionId: input.sessionId,
  };
}
