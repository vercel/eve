import { describe, expect, it } from "vitest";

import {
  clearProxyInputRequestsForChild,
  getProxyInputRequests,
  hasProxyInputRequests,
  markProxyInputRequestsAnswered,
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

  it("replaces prior entries for the same child continuation token", () => {
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
    expect(entries.size).toBe(1);
    expect(entries.get("req-2")).toEqual({
      childContinuationToken: "child-a",
      kind: "question",
    });
    expect(entries.has("req-1")).toBe(false);
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

describe("markProxyInputRequestsAnswered", () => {
  it("marks only routed request ids while retaining lifecycle entries", () => {
    const session = upsertProxyInputRequests({
      entries: [
        ["req-a", { childContinuationToken: "child-a", kind: "question" }],
        ["req-b", { childContinuationToken: "child-a", kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    const next = markProxyInputRequestsAnswered(session, new Set(["req-a"]));

    expect(getProxyInputRequests(next.state)).toEqual(
      new Map([
        ["req-a", { answered: true, childContinuationToken: "child-a", kind: "question" }],
        ["req-b", { childContinuationToken: "child-a", kind: "question" }],
      ]),
    );
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
});
