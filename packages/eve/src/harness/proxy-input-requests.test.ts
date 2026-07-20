import { describe, expect, it } from "vitest";

import {
  clearProxyInputRequest,
  clearProxyInputRequestsForChild,
  getProxyInputRequests,
  hasProxyInputRequests,
  type ProxyInputRequestEntry,
  upsertProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";

function createSession(state?: Record<string, unknown>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
    state,
  };
}

function createEntry(childContinuationToken: string, requestId: string): ProxyInputRequestEntry {
  return {
    childContinuationToken,
    event: { sequence: 2, stepIndex: 1, turnId: "parent-turn" },
    request: {
      action: {
        callId: `call-${requestId}`,
        input: {},
        kind: "tool-call",
        toolName: "ask_question",
      },
      prompt: "Choose",
      requestId,
    },
    subagent: {
      childSessionId: `session-${childContinuationToken}`,
      childTurnId: "child-turn",
      parentCallId: "parent-call",
      subagentName: "researcher",
    },
  };
}

describe("upsertProxyInputRequests", () => {
  it("records complete parent and child lifecycle identity", () => {
    const entry = createEntry("child-a", "req-1");
    const next = upsertProxyInputRequests({
      entries: [["req-1", entry]],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    expect(hasProxyInputRequests(next.state)).toBe(true);
    expect(getProxyInputRequests(next.state).get("req-1")).toEqual(entry);
  });

  it("replaces one child's old batch while preserving another child", () => {
    let session = upsertProxyInputRequests({
      entries: [["req-a", createEntry("child-a", "req-a")]],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });
    session = upsertProxyInputRequests({
      entries: [["req-b", createEntry("child-b", "req-b")]],
      forChildContinuationToken: "child-b",
      session,
    });
    session = upsertProxyInputRequests({
      entries: [["req-c", createEntry("child-a", "req-c")]],
      forChildContinuationToken: "child-a",
      session,
    });

    const entries = getProxyInputRequests(session.state);
    expect([...entries.keys()].sort()).toEqual(["req-b", "req-c"]);
  });
});

describe("proxy input settlement", () => {
  it("clears one settled request", () => {
    let session = upsertProxyInputRequests({
      entries: [
        ["req-a", createEntry("child-a", "req-a")],
        ["req-b", createEntry("child-a", "req-b")],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    session = clearProxyInputRequest(session, "req-a");
    expect([...getProxyInputRequests(session.state).keys()]).toEqual(["req-b"]);
  });

  it("clears every remaining request for a completed child", () => {
    let session = upsertProxyInputRequests({
      entries: [["req-a", createEntry("child-a", "req-a")]],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });
    session = upsertProxyInputRequests({
      entries: [["req-b", createEntry("child-b", "req-b")]],
      forChildContinuationToken: "child-b",
      session,
    });

    session = clearProxyInputRequestsForChild(session, "child-a");
    expect([...getProxyInputRequests(session.state).keys()]).toEqual(["req-b"]);
  });
});
