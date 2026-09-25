import { describe, expect, it } from "vitest";

import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";

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
  it("keeps original child inboxes separate when they share a continuation alias", () => {
    const session = upsertProxyInputRequests({
      entries: [
        [
          "req-a",
          {
            childContinuationToken: "child-alias",
            childSessionInbox: { sessionId: "child-a" },
            kind: "question",
          },
        ],
        [
          "req-b",
          {
            childContinuationToken: "child-alias",
            childSessionInbox: { sessionId: "child-b" },
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "child-alias",
      session: createSession(),
    });

    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [
          { requestId: "req-a", text: "A" },
          { requestId: "req-b", text: "B" },
        ],
      },
      state: session.state,
    });

    expect(routed.forChildren).toMatchObject([
      {
        childContinuationToken: "child-alias",
        childSessionInbox: { sessionId: "child-a" },
        payload: { inputResponses: [{ requestId: "req-a", text: "A" }] },
      },
      {
        childContinuationToken: "child-alias",
        childSessionInbox: { sessionId: "child-b" },
        payload: { inputResponses: [{ requestId: "req-b", text: "B" }] },
      },
    ]);
  });

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
        retireRequestIds: ["req-limit"],
      },
    ]);
    expect(routed.parentAction).toEqual({ kind: "cancel-turn" });
  });
});

describe("routeDeliverPayload message resolution", () => {
  function askSession(
    questions: ReadonlyArray<
      readonly [requestId: string, question: { allowFreeform?: boolean; dismissible?: boolean }]
    >,
  ): HarnessSession {
    let session = createSession();
    for (const [requestId, question] of questions) {
      session = upsertProxyInputRequests({
        entries: [
          [
            requestId,
            {
              answerHook: {
                question: {
                  ...question,
                  options: [
                    { id: "1", label: "Staging" },
                    { id: "2", label: "Production" },
                  ],
                },
                runId: `run-${requestId}`,
              },
              childContinuationToken: `hook-${requestId}`,
              kind: "question",
            },
          ],
        ],
        forChildContinuationToken: `hook-${requestId}`,
        session,
      });
    }
    return session;
  }

  it("answers the only pending question with a matching option label", () => {
    const routed = routeDeliverPayload({
      payload: { message: "production" },
      resolveMessage: true,
      state: askSession([["ask-1", { dismissible: true }]]).state,
    });

    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren).toMatchObject([
      {
        childContinuationToken: "hook-ask-1",
        payload: { inputResponses: [{ optionId: "2", requestId: "ask-1" }] },
        retireRequestIds: ["ask-1"],
      },
    ]);
    expect(routed.forChildren[0]?.dismissedRequestIds).toBeUndefined();
  });

  it("answers the only pending question with free text when it allows it", () => {
    const routed = routeDeliverPayload({
      payload: { message: "Use the canary pool" },
      resolveMessage: true,
      state: askSession([["ask-1", { allowFreeform: true, dismissible: true }]]).state,
    });

    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren[0]?.payload.inputResponses).toEqual([
      { requestId: "ask-1", text: "Use the canary pool" },
    ]);
  });

  it("dismisses dismissible questions and keeps an unrelated message for the turn", () => {
    const routed = routeDeliverPayload({
      payload: { message: "Actually, check the logs first." },
      resolveMessage: true,
      state: askSession([
        ["ask-1", { dismissible: true }],
        ["ask-2", {}],
      ]).state,
    });

    expect(routed.forSelf).toEqual({ message: "Actually, check the logs first." });
    expect(routed.forChildren).toEqual([
      {
        answerHook: expect.objectContaining({ runId: "run-ask-1" }),
        childContinuationToken: "hook-ask-1",
        dismissedRequestIds: ["ask-1"],
        payload: { inputResponses: [] },
        retireRequestIds: ["ask-1"],
      },
    ]);
  });

  it("does not answer a question while a subagent question is also pending", () => {
    const session = upsertProxyInputRequests({
      entries: [["child-ask", { childContinuationToken: "child-token", kind: "question" }]],
      forChildContinuationToken: "child-token",
      session: askSession([["ask-1", { allowFreeform: true, dismissible: true }]]),
    });
    const routed = routeDeliverPayload({
      payload: { message: "Use the canary pool" },
      resolveMessage: true,
      state: session.state,
    });

    expect(routed.forSelf).toEqual({ message: "Use the canary pool" });
    expect(routed.forChildren).toMatchObject([{ dismissedRequestIds: ["ask-1"] }]);
  });

  it("leaves questions alone unless a person's message may resolve them", () => {
    const routed = routeDeliverPayload({
      payload: { message: "production" },
      state: askSession([["ask-1", { dismissible: true }]]).state,
    });

    expect(routed.forSelf).toEqual({ message: "production" });
    expect(routed.forChildren).toEqual([]);
  });

  it("routes only the first answer when a payload repeats a request", () => {
    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [
          { optionId: "1", requestId: "ask-1" },
          { optionId: "2", requestId: "ask-1" },
        ],
      },
      state: askSession([["ask-1", {}]]).state,
    });

    expect(routed.forChildren[0]?.payload.inputResponses).toEqual([
      { optionId: "1", requestId: "ask-1" },
    ]);
  });

  it("prefers explicit input responses over resolving the message", () => {
    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [{ optionId: "1", requestId: "ask-1" }],
        message: "production",
      },
      resolveMessage: true,
      state: askSession([["ask-1", { dismissible: true }]]).state,
    });

    expect(routed.forSelf).toEqual({ message: "production" });
    expect(routed.forChildren[0]?.payload.inputResponses).toEqual([
      { optionId: "1", requestId: "ask-1" },
    ]);
  });
});
