import { describe, expect, it } from "vitest";
import { withRelays } from "#internal/testing/session-machine.js";

import { readHitlState } from "./requests.js";

import { parseProxyInputRequest, toProxyInputRequestEntries } from "./relays.js";
import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import { inputOptionSchema, type InputRequest, type InputRequestKind } from "#shared/input.js";
import type { HarnessSession } from "#harness/types.js";

const REQUEST_EVENT = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

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
    const next = withRelays(session, {
      entries: [
        ["req-1", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
    });

    expect(readHitlState(next.state).relays.size > 0).toBe(true);
    expect(readHitlState(next.state).relays.get("req-1")).toEqual({
      childContinuationToken: "child-a",
      event: REQUEST_EVENT,
      kind: "question",
    });
  });

  it("replaces prior entries for the same child continuation token", () => {
    let session = withRelays(createSession(), {
      entries: [
        ["req-1", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
    });

    session = withRelays(session, {
      entries: [
        ["req-2", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
    });

    const entries = readHitlState(session.state).relays;
    expect(entries.size).toBe(1);
    expect(entries.get("req-1")).toBeUndefined();
    expect(entries.get("req-2")).toEqual({
      childContinuationToken: "child-a",
      event: REQUEST_EVENT,
      kind: "question",
    });
  });

  it("keeps independent questions at the same answer destination", () => {
    let session = withRelays(createSession(), {
      entries: [
        [
          "alice",
          {
            childContinuationToken: "shared-inbox",
            inputSource: "workflow-alice",
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "shared-inbox",
      inputSource: "workflow-alice",
    });
    session = withRelays(session, {
      entries: [
        [
          "bob",
          {
            childContinuationToken: "shared-inbox",
            inputSource: "workflow-bob",
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "shared-inbox",
      inputSource: "workflow-bob",
    });

    expect([...readHitlState(session.state).relays.keys()]).toEqual(["alice", "bob"]);
  });

  it("preserves remote response coordinates through a durable proxy snapshot", () => {
    const remote = {
      name: "research",
      resolverId: "subagents/research.ts",
      sessionId: "remote-child-session",
      url: "https://remote.example.com",
    };
    const payload: SubagentInputRequestHookPayload = {
      callId: "call-1",
      childContinuationToken: "remote-reply",
      childSessionId: "remote-child-session",
      event: { requests: [createRequest("req-remote", "question")], ...REQUEST_EVENT },
      kind: "subagent-input-request",
      remote,
      subagentName: "research",
    };
    const session = withRelays(createSession(), {
      entries: toProxyInputRequestEntries(payload),
      forChildContinuationToken: payload.childContinuationToken,
    });
    expect(
      readHitlState(JSON.parse(JSON.stringify(session.state))).relays.get("req-remote"),
    ).toMatchObject({
      remote,
      childContinuationToken: "remote-reply",
    });
  });

  it("drops a prior child's batch when its request ID is claimed by another child", () => {
    let session = withRelays(createSession(), {
      entries: [
        ["req-1", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
        ["req-2", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
    });

    session = withRelays(session, {
      entries: [
        [
          "req-1",
          { childContinuationToken: "child-b", event: REQUEST_EVENT, kind: "tool-approval" },
        ],
      ],
      forChildContinuationToken: "child-b",
    });

    expect(Object.fromEntries(readHitlState(session.state).relays)).toEqual({
      "req-1": { childContinuationToken: "child-b", event: REQUEST_EVENT, kind: "tool-approval" },
      "req-2": { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" },
    });
  });

  it("keeps entries from other children when upserting", () => {
    let session = withRelays(createSession(), {
      entries: [
        ["req-a", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
    });

    session = withRelays(session, {
      entries: [
        [
          "req-b",
          { childContinuationToken: "child-b", event: REQUEST_EVENT, kind: "tool-approval" },
        ],
      ],
      forChildContinuationToken: "child-b",
    });

    const entries = readHitlState(session.state).relays;
    expect(entries.size).toBe(2);
    expect(entries.get("req-a")).toEqual({
      childContinuationToken: "child-a",
      event: REQUEST_EVENT,
      kind: "question",
    });
    expect(entries.get("req-b")).toEqual({
      childContinuationToken: "child-b",
      event: REQUEST_EVENT,
      kind: "tool-approval",
    });
  });
});

describe("toProxyInputRequestEntries", () => {
  it("persists the original child's inbox through a session snapshot round trip", () => {
    const childSessionInbox = { sessionId: "original-child", version: 1 };
    const entries = toProxyInputRequestEntries({
      callId: "call-1",
      childContinuationToken: "reusable-alias",
      childSessionId: "original-child",
      childSessionInbox,
      event: {
        requests: [createRequest("req-1", "question")],
        sequence: 0,
        stepIndex: 0,
        turnId: "t",
      },
      kind: "subagent-input-request",
      subagentName: "delegate",
    });
    const session = withRelays(createSession(), {
      entries: entries,
      forChildContinuationToken: "reusable-alias",
    });

    expect(readHitlState(JSON.parse(JSON.stringify(session.state))).relays.get("req-1")).toEqual(
      expect.objectContaining({ childSessionInbox }),
    );
  });

  it("records batch, approval, and reply metadata on every route", () => {
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
          event: { sequence: 3, stepIndex: 2, turnId: "turn-1" },
          kind: "question",
          reply: {},
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
          event: { sequence: 3, stepIndex: 2, turnId: "turn-1" },
          kind: "tool-approval",
          reply: {},
        },
      ],
    ]);
  });
});

describe("getProxyInputRequests type safety", () => {
  it("returns an empty map when the session carries no proxy state", () => {
    const entries = readHitlState(createSession().state).relays;
    expect(entries.size).toBe(0);
  });

  it("ignores malformed values in the state map", () => {
    const session = createSession({
      "eve.runtime.hitl.requests": {
        relays: {
          "req-1": 42,
          "req-2": { childContinuationToken: 42, event: REQUEST_EVENT, kind: "question" },
          "req-3": { childContinuationToken: "child-c", kind: "other" },
          "req-4": { childContinuationToken: "child-d", event: REQUEST_EVENT, kind: "question" },
        },
      },
    });
    const entries = readHitlState(session.state).relays;
    expect(entries.size).toBe(1);
    expect(entries.get("req-4")).toEqual({
      childContinuationToken: "child-d",
      event: REQUEST_EVENT,
      kind: "question",
    });
  });

  it("ignores a legacy array-shaped value", () => {
    const session = createSession({
      "eve.runtime.hitl.requests": { relays: [{ requestId: "req-1" }] },
    });
    expect(readHitlState(session.state).relays.size).toBe(0);
  });

  it("keeps legacy routes and ignores malformed optional batch metadata", () => {
    const session = createSession({
      "eve.runtime.hitl.requests": {
        relays: {
          legacy: { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" },
          malformed: {
            batch: { approvalRequestIds: ["other"], requestIds: ["malformed"] },
            childContinuationToken: "child-a",
            event: REQUEST_EVENT,
            kind: "tool-approval",
          },
        },
      },
    });

    expect([...readHitlState(session.state).relays]).toEqual([
      ["legacy", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      [
        "malformed",
        { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "tool-approval" },
      ],
    ]);
  });
});

describe("parseProxyInputRequest", () => {
  it("keeps reply options shaped like input options and drops a route with any other", () => {
    const parse = (options: unknown) =>
      parseProxyInputRequest(
        {
          childContinuationToken: "child",
          event: REQUEST_EVENT,
          kind: "question",
          reply: { options },
        },
        "req-1",
      );
    const options = [
      { id: "a", label: "A" },
      { description: "Ship it.", id: "b", label: "B", style: "danger" },
    ];
    expect(parse(options)?.reply?.options).toEqual(options);
    for (const malformed of [
      [{ id: "a" }],
      [{ id: "a", label: "A", style: "loud" }],
      [{ id: "a", label: "A", value: 1 }],
      { id: "a", label: "A" },
      Array(1),
    ]) {
      expect(parse(malformed)).toBeUndefined();
    }
  });

  it("accepts exactly the reply options inputOptionSchema accepts", () => {
    const parse = (options: unknown) =>
      parseProxyInputRequest(
        {
          childContinuationToken: "child",
          event: REQUEST_EVENT,
          kind: "question",
          reply: { options },
        },
        "req-1",
      );
    const option = { id: "a", label: "A" };
    for (const options of [
      [],
      [option],
      [{ ...option, description: "d", style: "primary" }],
      [{ ...option, description: undefined, style: undefined }],
      [{ ...option, description: 1 }],
      [{ ...option, style: "loud" }],
      [{ ...option, value: 1 }],
      [{ id: "a" }],
      [{ label: "A" }],
      [null],
      ["a"],
      [[option]],
      [option, undefined],
      Array(1),
      option,
      "a",
      null,
    ]) {
      expect(parse(options) !== undefined, JSON.stringify(options)).toBe(
        inputOptionSchema.array().safeParse(options).success,
      );
    }
  });
});
