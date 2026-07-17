import { describe, expect, it } from "vitest";

import {
  getPendingRuntimeActionBatch,
  recordPendingSubagentChild,
  resolvePendingRuntimeActions,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { getSessionTokenUsage, setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

function createParkedSession(): HarnessSession {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [{ content: "delegate this", role: "user" }],
    sessionId: "test-session",
  };

  const ownUsage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 1_000,
    outputTokens: 100,
    sawCost: false,
  };
  const withUsage = setTurnUsageState(base, {
    ...ownUsage,
    session: ownUsage,
    turnId: "turn_0",
  });

  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "call-1",
        description: "research subagent",
        input: { message: "go" },
        kind: "subagent-call",
        name: "researcher",
        nodeId: "subagents/researcher",
        subagentName: "researcher",
      },
    ],
    event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    responseMessages: [],
    session: withUsage,
  });
}

describe("resolvePendingRuntimeActions", () => {
  it("draws completed child usage down against the parent's session totals", async () => {
    const session = createParkedSession();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
            usage: {
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              inputTokens: 4_000,
              outputTokens: 400,
            },
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 5_000,
      outputTokens: 500,
    });
  });

  it("leaves the parent's totals untouched when the child reports no usage", async () => {
    const session = createParkedSession();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
    });
  });
});

describe("pending subagent child adoption", () => {
  it("records child session ids without disturbing local continuation-token cleanup", () => {
    let session = createParkedSession();
    session = recordPendingSubagentChild({
      callId: "call-1",
      child: {
        continuationToken: "subagent:test-session:call-1",
        kind: "local",
        sessionId: "local-child",
      },
      session,
    });
    session = recordPendingSubagentChild({
      callId: "call-remote",
      child: { kind: "remote", sessionId: "remote-child" },
      session,
    });

    expect(getPendingRuntimeActionBatch(session.state)).toMatchObject({
      childContinuationTokens: {
        "call-1": "subagent:test-session:call-1",
      },
      childSessionIds: {
        "call-1": "local-child",
        "call-remote": "remote-child",
      },
    });
  });
});
