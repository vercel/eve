import { describe, expect, it } from "vitest";

import {
  getPendingRuntimeActionBatch,
  recordPendingSubagentChild,
  resolvePendingRuntimeActions,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { getSessionTokenUsage, setTurnUsageState } from "#harness/turn-tag-state.js";
import { getProxyInputRequests, upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
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

  it("settles a child request as failed before projecting the failed child action", async () => {
    let session = recordPendingSubagentChild({
      callId: "call-1",
      child: {
        continuationToken: "subagent:test-session:call-1",
        kind: "local",
        sessionId: "child-session",
      },
      session: createParkedSession(),
    });
    session = upsertProxyInputRequests({
      entries: [
        [
          "child-request",
          {
            childContinuationToken: "subagent:test-session:call-1",
            event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
            request: {
              action: {
                callId: "child-question",
                input: {},
                kind: "tool-call",
                toolName: "ask_question",
              },
              prompt: "Choose",
              requestId: "child-request",
            },
            subagent: {
              childSessionId: "child-session",
              childTurnId: "child-turn",
              parentCallId: "call-1",
              subagentName: "researcher",
            },
          },
        ],
      ],
      forChildContinuationToken: "subagent:test-session:call-1",
      session,
    });
    const events: HandleMessageStreamEvent[] = [];

    const resolved = await resolvePendingRuntimeActions({
      emit: async (event) => {
        events.push(event);
      },
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            isError: true,
            kind: "subagent-result",
            output: { code: "CHILD_FAILED" },
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          inputSettlement: { outcome: "failed", requestId: "child-request" },
          result: expect.objectContaining({ callId: "child-question" }),
        }),
        meta: {
          at: expect.any(String),
          subagent: expect.objectContaining({ childSessionId: "child-session" }),
        },
        type: "action.result",
      }),
      expect.objectContaining({
        data: expect.objectContaining({ result: expect.objectContaining({ callId: "call-1" }) }),
        type: "action.result",
      }),
    ]);
    expect(getProxyInputRequests(resolved.session.state).size).toBe(0);
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
