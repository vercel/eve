import type { HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
import { describe, expect, it } from "vitest";

import {
  getPersistedHarnessAgentSession,
  setPersistedHarnessAgentSession,
} from "#harness/harness-agent-persistence.js";
import type { HarnessSession } from "#harness/types.js";

const resumeFrom: HarnessAgentResumeSessionState = {
  data: { cursor: 1 },
  harnessId: "test-harness",
  specificationVersion: "harness-v1",
  type: "resume-session",
};

function createEveSession(overrides?: Partial<HarnessSession>): HarnessSession {
  return {
    agent: {
      harnessId: "test-harness",
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "test-continuation",
    history: [],
    sessionId: "eve-session",
    ...overrides,
  };
}

describe("HarnessAgent persistence", () => {
  it("stores and reads resume state", () => {
    const persistedSession = setPersistedHarnessAgentSession({
      persistence: {
        resumeFrom,
        sessionId: "harness-session",
        version: 1,
      },
      session: createEveSession({ state: { retained: true } }),
    });

    expect(getPersistedHarnessAgentSession({ session: persistedSession })).toEqual({
      resumeFrom,
      sessionId: "harness-session",
      version: 1,
    });
    expect(persistedSession.state?.retained).toBe(true);
  });

  it("rejects malformed persisted state", () => {
    const malformed = createEveSession({
      state: { "eve.harness.agentSession": { version: 2 } },
    });

    expect(() => getPersistedHarnessAgentSession({ session: malformed })).toThrow(
      "Unsupported persisted HarnessAgent session state",
    );
  });
});
