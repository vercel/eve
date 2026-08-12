import { describe, expect, it } from "vitest";

import {
  retireProxyInputRequests,
  upsertProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import type { ProxyInputRequest } from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
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

function addBatchRoutes(
  session: HarnessSession,
  requests: readonly { readonly kind: ProxyInputRequest["kind"]; readonly requestId: string }[],
): HarnessSession {
  const batch = {
    approvalRequestIds: requests.flatMap((request) =>
      request.kind === "tool-approval" ? [request.requestId] : [],
    ),
    requestIds: requests.map((request) => request.requestId),
  };
  return upsertProxyInputRequests({
    entries: requests.map((request) => [
      request.requestId,
      { batch, childContinuationToken: "child-a", kind: request.kind },
    ]),
    forChildContinuationToken: "child-a",
    session,
  });
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

  it("keeps one task response batch atomic and marks it for its task run", () => {
    const session = upsertProxyInputRequests({
      entries: [
        [
          "task-1:req-a",
          {
            childContinuationToken: "child-a",
            childRequestId: "req-a",
            kind: "tool-approval",
            taskId: "task-1",
          },
        ],
        [
          "task-1:req-b",
          {
            childContinuationToken: "child-a",
            childRequestId: "req-b",
            kind: "question",
            taskId: "task-1",
          },
        ],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [
          { optionId: "approve", requestId: "task-1:req-a" },
          { text: "west", requestId: "task-1:req-b" },
        ],
      },
      state: session.state,
    });

    expect(routed.forChildren).toEqual([
      {
        childContinuationToken: "child-a",
        payload: {
          inputResponses: [
            { optionId: "approve", requestId: "req-a" },
            { text: "west", requestId: "req-b" },
          ],
        },
        taskId: "task-1",
      },
    ]);
  });

  it("keeps identical child-local ids isolated across tasks", () => {
    let session = upsertProxyInputRequests({
      entries: [
        [
          "task-1:req-shared",
          {
            childContinuationToken: "child-a",
            childRequestId: "req-shared",
            kind: "tool-approval",
            taskId: "task-1",
          },
        ],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });
    session = upsertProxyInputRequests({
      entries: [
        [
          "task-2:req-shared",
          {
            childContinuationToken: "child-b",
            childRequestId: "req-shared",
            kind: "tool-approval",
            taskId: "task-2",
          },
        ],
      ],
      forChildContinuationToken: "child-b",
      session,
    });

    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [{ optionId: "approve", requestId: "task-1:req-shared" }],
      },
      state: session.state,
    });

    expect(routed.forChildren).toEqual([
      {
        childContinuationToken: "child-a",
        payload: { inputResponses: [{ optionId: "approve", requestId: "req-shared" }] },
        taskId: "task-1",
      },
    ]);
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

  it("retires an entire question batch after one answer", () => {
    const session = addBatchRoutes(createSession(), [
      { kind: "question", requestId: "question-1" },
      { kind: "question", requestId: "question-2" },
    ]);

    const routed = routeDeliverPayload({
      payload: { inputResponses: [{ requestId: "question-1", text: "answer" }] },
      state: session.state,
    });

    expect(new Set(routed.forChildren[0]?.retireRequestIds)).toEqual(
      new Set(["question-1", "question-2"]),
    );
  });

  it("retires a mixed batch when all of its approvals are answered", () => {
    const session = addBatchRoutes(createSession(), [
      { kind: "question", requestId: "question-1" },
      { kind: "tool-approval", requestId: "approval-1" },
    ]);

    const routed = routeDeliverPayload({
      payload: { inputResponses: [{ optionId: "approve", requestId: "approval-1" }] },
      state: session.state,
    });

    expect(new Set(routed.forChildren[0]?.retireRequestIds)).toEqual(
      new Set(["question-1", "approval-1"]),
    );
  });

  it("keeps unresolved approval routes across partial multi-approval responses", () => {
    let session = addBatchRoutes(createSession(), [
      { kind: "tool-approval", requestId: "approval-1" },
      { kind: "tool-approval", requestId: "approval-2" },
    ]);

    const partial = routeDeliverPayload({
      payload: { inputResponses: [{ optionId: "approve", requestId: "approval-1" }] },
      state: session.state,
    });
    expect(partial.forChildren[0]?.retireRequestIds).toEqual(["approval-1"]);

    session = retireProxyInputRequests(session, partial.forChildren[0]?.retireRequestIds ?? []);
    const completed = routeDeliverPayload({
      payload: { inputResponses: [{ optionId: "cancel", requestId: "approval-2" }] },
      state: session.state,
    });
    expect(new Set(completed.forChildren[0]?.retireRequestIds)).toEqual(
      new Set(["approval-1", "approval-2"]),
    );
  });

  it("keeps request-only retirement for legacy routes without batch metadata", () => {
    const session = upsertProxyInputRequests({
      entries: [
        ["question-1", { childContinuationToken: "child-a", kind: "question" }],
        ["question-2", { childContinuationToken: "child-a", kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    const routed = routeDeliverPayload({
      payload: { inputResponses: [{ requestId: "question-1", text: "answer" }] },
      state: session.state,
    });

    expect(routed.forChildren[0]?.retireRequestIds).toEqual(["question-1"]);
  });
});
