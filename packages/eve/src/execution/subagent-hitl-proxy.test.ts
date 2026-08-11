import { describe, expect, it } from "vitest";

import {
  markProxyInputRequestsAnswered,
  upsertProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#runtime/input/types.js";
import { routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";

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

describe("routeDeliverPayload", () => {
  it("routes responses to matching descendants and keeps unknown ones on forSelf", () => {
    const session = upsertProxyInputRequests({
      entries: [["req-a", { childContinuationToken: "child-a", kind: "tool-approval" }]],
      forChildContinuationToken: "child-a",
      session: upsertProxyInputRequests({
        entries: [["req-b", { childContinuationToken: "child-b", kind: "tool-approval" }]],
        forChildContinuationToken: "child-b",
        session: createSession(),
      }),
    });

    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [
          { optionId: "approve", requestId: "req-a" },
          { optionId: "cancel", requestId: "req-b" },
          { optionId: "ignore", requestId: "req-parent" },
        ],
      },
      state: session.state,
    });

    expect(routed.forChildren).toHaveLength(2);
    const childA = routed.forChildren.find((c) => c.childContinuationToken === "child-a");
    const childB = routed.forChildren.find((c) => c.childContinuationToken === "child-b");
    expect(childA?.payload.inputResponses).toEqual([{ optionId: "approve", requestId: "req-a" }]);
    expect(childB?.payload.inputResponses).toEqual([{ optionId: "cancel", requestId: "req-b" }]);

    expect(routed.forSelf?.inputResponses).toEqual([
      { optionId: "ignore", requestId: "req-parent" },
    ]);
  });

  it("preserves non-inputResponses fields on forSelf", () => {
    const session = createSession();
    const routed = routeDeliverPayload({
      payload: {
        message: "hello",
        customField: { foo: 1 },
      },
      state: session.state,
    });

    expect(routed.forChildren).toHaveLength(0);
    expect(routed.forSelf).toEqual({ message: "hello", customField: { foo: 1 } });
  });

  it("resolves and routes raw text for a descendant options-only question", () => {
    const request: InputRequest = {
      action: { callId: "req-question", input: {}, kind: "tool-call", toolName: "ask_question" },
      allowFreeform: false,
      display: "select",
      kind: "question",
      options: [
        { id: "first", label: "First" },
        { id: "second", label: "Second" },
      ],
      prompt: "Which should I analyze?",
      requestId: "req-question",
    };
    const session = upsertProxyInputRequests({
      entries: [
        [request.requestId, { childContinuationToken: "child-a", kind: request.kind, request }],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    const routed = routeDeliverPayload({
      payload: { message: "Analyze both, one by one." },
      state: session.state,
    });

    expect(routed.forChildren).toEqual([
      {
        childContinuationToken: "child-a",
        payload: {
          inputResponses: [{ requestId: "req-question", text: "Analyze both, one by one." }],
        },
      },
    ]);
    expect(routed.forSelf).toBeUndefined();
  });

  it("does not route later messages through an already-answered proxy entry", () => {
    const request: InputRequest = {
      action: { callId: "req-question", input: {}, kind: "tool-call", toolName: "ask_question" },
      allowFreeform: false,
      kind: "question",
      options: [{ id: "first", label: "First" }],
      prompt: "Which should I analyze?",
      requestId: "req-question",
    };
    const session = markProxyInputRequestsAnswered(
      upsertProxyInputRequests({
        entries: [
          [request.requestId, { childContinuationToken: "child-a", kind: request.kind, request }],
        ],
        forChildContinuationToken: "child-a",
        session: createSession(),
      }),
      new Set([request.requestId]),
    );

    const routed = routeDeliverPayload({
      payload: { message: "This belongs to the parent." },
      state: session.state,
    });

    expect(routed.forChildren).toEqual([]);
    expect(routed.forSelf).toEqual({ message: "This belongs to the parent." });
  });

  it("returns forSelf as undefined when every response routes to a descendant", () => {
    const session = upsertProxyInputRequests({
      entries: [["req-a", { childContinuationToken: "child-a", kind: "tool-approval" }]],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [{ optionId: "approve", requestId: "req-a" }],
      },
      state: session.state,
    });

    expect(routed.forChildren).toHaveLength(1);
    expect(routed.forSelf).toBeUndefined();
  });

  it("asks the parent to cancel after routing Stop to a descendant session-limit request", () => {
    const session = upsertProxyInputRequests({
      entries: [["req-limit", { childContinuationToken: "child-a", kind: "session-limit" }]],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [{ optionId: "stop", requestId: "req-limit" }],
      },
      state: session.state,
    });

    expect(routed.forChildren).toEqual([
      {
        childContinuationToken: "child-a",
        payload: { inputResponses: [{ optionId: "stop", requestId: "req-limit" }] },
      },
    ]);
    expect(routed.parentAction).toEqual({ kind: "cancel-turn" });
  });
});
