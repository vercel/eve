import { describe, expect, it } from "vitest";

import {
  clearProxyInputRequestsForChild,
  getProxyInputRequests,
  hasProxyInputRequests,
  retireProxyInputRequests,
  toProxyInputRequestEntries,
  upsertProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { InputRequest, InputRequestKind } from "#runtime/input/types.js";
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

function createRequest(requestId: string, kind: InputRequestKind): InputRequest {
  return {
    action: { callId: requestId, input: {}, kind: "tool-call", toolName: "test" },
    kind,
    prompt: "Respond",
    requestId,
  };
}

describe("upsertProxyInputRequests", () => {
  it("records a fresh batch of proxy entries", () => {
    const session = createSession();
    const next = upsertProxyInputRequests({
      entries: [["req-1", { childContinuationToken: "child-a", kind: "question" }]],
      forChildContinuationToken: "child-a",
      session,
    });

    expect(hasProxyInputRequests(next.state)).toBe(true);
    expect(getProxyInputRequests(next.state).get("req-1")).toEqual({
      childContinuationToken: "child-a",
      kind: "question",
    });
  });

  it("keeps two batches from the same child independently addressable", () => {
    let session = upsertProxyInputRequests({
      entries: [["req-1", { childContinuationToken: "child-a", kind: "question" }]],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    session = upsertProxyInputRequests({
      entries: [["req-2", { childContinuationToken: "child-a", kind: "question" }]],
      forChildContinuationToken: "child-a",
      session,
    });

    const entries = getProxyInputRequests(session.state);
    expect(entries.size).toBe(2);
    expect(entries.get("req-1")).toEqual({
      childContinuationToken: "child-a",
      kind: "question",
    });
    expect(entries.get("req-2")).toEqual({
      childContinuationToken: "child-a",
      kind: "question",
    });
  });

  it("replaces only a reused request ID", () => {
    let session = upsertProxyInputRequests({
      entries: [
        ["req-1", { childContinuationToken: "child-a", kind: "question" }],
        ["req-2", { childContinuationToken: "child-a", kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    session = upsertProxyInputRequests({
      entries: [["req-1", { childContinuationToken: "child-b", kind: "tool-approval" }]],
      forChildContinuationToken: "child-b",
      session,
    });

    expect([...getProxyInputRequests(session.state)]).toEqual([
      ["req-1", { childContinuationToken: "child-b", kind: "tool-approval" }],
      ["req-2", { childContinuationToken: "child-a", kind: "question" }],
    ]);
  });

  it("keeps entries from other children when upserting", () => {
    let session = upsertProxyInputRequests({
      entries: [["req-a", { childContinuationToken: "child-a", kind: "question" }]],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    session = upsertProxyInputRequests({
      entries: [["req-b", { childContinuationToken: "child-b", kind: "tool-approval" }]],
      forChildContinuationToken: "child-b",
      session,
    });

    const entries = getProxyInputRequests(session.state);
    expect(entries.size).toBe(2);
    expect(entries.get("req-a")).toEqual({
      childContinuationToken: "child-a",
      kind: "question",
    });
    expect(entries.get("req-b")).toEqual({
      childContinuationToken: "child-b",
      kind: "tool-approval",
    });
  });
});

describe("toProxyInputRequestEntries", () => {
  it("records shared batch and approval metadata on every route", () => {
    const requests = [
      createRequest("question-1", "question"),
      createRequest("approval-1", "tool-approval"),
    ];
    const payload = {
      callId: "call-1",
      childContinuationToken: "child-a",
      childSessionId: "child-session",
      event: { requests, sequence: 3, stepIndex: 2, turnId: "turn-1" },
      kind: "subagent-input-request",
      subagentName: "delegate",
    } satisfies SubagentInputRequestHookPayload;

    expect(toProxyInputRequestEntries(payload)).toEqual([
      [
        "question-1",
        {
          batch: {
            approvalRequestIds: ["approval-1"],
            requestIds: ["question-1", "approval-1"],
          },
          childContinuationToken: "child-a",
          kind: "question",
        },
      ],
      [
        "approval-1",
        {
          batch: {
            approvalRequestIds: ["approval-1"],
            requestIds: ["question-1", "approval-1"],
          },
          childContinuationToken: "child-a",
          kind: "tool-approval",
        },
      ],
    ]);
  });
});

describe("clearProxyInputRequestsForChild", () => {
  it("removes only the target child's entries", () => {
    let session = upsertProxyInputRequests({
      entries: [["req-a", { childContinuationToken: "child-a", kind: "question" }]],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    session = upsertProxyInputRequests({
      entries: [["req-b", { childContinuationToken: "child-b", kind: "tool-approval" }]],
      forChildContinuationToken: "child-b",
      session,
    });

    session = clearProxyInputRequestsForChild(session, "child-a");
    const entries = getProxyInputRequests(session.state);

    expect(entries.size).toBe(1);
    expect(entries.get("req-b")).toEqual({
      childContinuationToken: "child-b",
      kind: "tool-approval",
    });
  });

  it("returns the same session when there is nothing to clear", () => {
    const session = createSession();
    const next = clearProxyInputRequestsForChild(session, "missing");
    expect(next).toBe(session);
  });
});

describe("retireProxyInputRequests", () => {
  it("removes only answered request IDs, including partial same-child batches", () => {
    const session = upsertProxyInputRequests({
      entries: [
        ["req-1", { childContinuationToken: "child-a", kind: "question" }],
        ["req-2", { childContinuationToken: "child-a", kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    const next = retireProxyInputRequests(session, ["req-1"]);

    expect([...getProxyInputRequests(next.state)]).toEqual([
      ["req-2", { childContinuationToken: "child-a", kind: "question" }],
    ]);
  });

  it("is idempotent for an already-retired request ID", () => {
    const session = createSession();
    expect(retireProxyInputRequests(session, ["req-1"])).toBe(session);
  });
});

describe("getProxyInputRequests type safety", () => {
  it("returns an empty map when the session carries no proxy state", () => {
    const entries = getProxyInputRequests(createSession().state);
    expect(entries.size).toBe(0);
  });

  it("ignores malformed values in the state map", () => {
    const session = createSession({
      "eve.runtime.proxyInputRequests": {
        "req-1": 42,
        "req-2": { childContinuationToken: 42, kind: "question" },
        "req-3": { childContinuationToken: "child-c", kind: "other" },
        "req-4": { childContinuationToken: "child-d", kind: "question" },
      },
    });
    const entries = getProxyInputRequests(session.state);
    expect(entries.size).toBe(1);
    expect(entries.get("req-4")).toEqual({
      childContinuationToken: "child-d",
      kind: "question",
    });
  });

  it("ignores a legacy array-shaped value", () => {
    const session = createSession({
      "eve.runtime.proxyInputRequests": [{ requestId: "req-1" }],
    });
    expect(getProxyInputRequests(session.state).size).toBe(0);
  });

  it("keeps legacy routes and ignores malformed optional batch metadata", () => {
    const session = createSession({
      "eve.runtime.proxyInputRequests": {
        legacy: { childContinuationToken: "child-a", kind: "question" },
        malformed: {
          batch: { approvalRequestIds: ["other"], requestIds: ["malformed"] },
          childContinuationToken: "child-a",
          kind: "tool-approval",
        },
      },
    });

    expect([...getProxyInputRequests(session.state)]).toEqual([
      ["legacy", { childContinuationToken: "child-a", kind: "question" }],
      ["malformed", { childContinuationToken: "child-a", kind: "tool-approval" }],
    ]);
  });
});
