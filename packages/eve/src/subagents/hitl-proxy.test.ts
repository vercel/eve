import { describe, expect, it } from "vitest";

import {
  retireProxyInputRequests,
  toProxyInputRequestEntries,
  upsertProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import { withParkedStep } from "#internal/testing/session-machine.js";
import type { InputRequest } from "#shared/input.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";

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

describe("routeDeliverPayload", () => {
  it("keeps original child inboxes separate when they share a continuation alias", () => {
    const session = upsertProxyInputRequests({
      entries: [
        [
          "req-a",
          {
            childContinuationToken: "child-alias",
            childSessionInbox: { sessionId: "child-a" },
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
        [
          "req-b",
          {
            childContinuationToken: "child-alias",
            childSessionInbox: { sessionId: "child-b" },
            event: REQUEST_EVENT,
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
      entries: [
        [
          "req-a",
          { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "tool-approval" },
        ],
      ],
      forChildContinuationToken: "child-a",
      session: upsertProxyInputRequests({
        entries: [
          [
            "req-b",
            { childContinuationToken: "child-b", event: REQUEST_EVENT, kind: "tool-approval" },
          ],
        ],
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
      entries: [
        [
          "req-a",
          { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "tool-approval" },
        ],
      ],
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
      entries: [
        [
          "req-limit",
          { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "session-limit" },
        ],
      ],
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
        resolved: {
          event: REQUEST_EVENT,
          resolutions: [
            {
              kind: "session-limit",
              outcome: "answered",
              requestId: "req-limit",
              response: { optionId: "stop", requestId: "req-limit" },
            },
          ],
        },
      },
    ]);
    expect(routed.parentAction).toEqual({ kind: "cancel-turn" });
  });
});

describe("routeDeliverPayload source coordinates", () => {
  it("keeps distinct input batches for one remote session separate", () => {
    let session = createSession();
    for (const [index, name] of ["alice", "bob"].entries()) {
      session = upsertProxyInputRequests({
        entries: [
          [
            `ask-${name}`,
            {
              childContinuationToken: "remote-inbox",
              remote: {
                name: "remote-child",
                url: "https://remote.example",
                sessionId: "remote-session",
              },
              inputSource: `workflow-${name}`,
              event: { sequence: index, stepIndex: index + 1, turnId: `turn-${name}` },
              kind: "question",
            },
          ],
        ],
        forChildContinuationToken: "remote-inbox",
        inputSource: `workflow-${name}`,
        session,
      });
    }
    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [
          { requestId: "ask-alice", text: "lantern" },
          { requestId: "ask-bob", text: "comet" },
        ],
      },
      state: session.state,
    });
    expect(routed.forChildren).toHaveLength(2);
    expect(routed.forChildren.map(({ resolved }) => resolved)).toEqual([
      {
        event: { sequence: 0, stepIndex: 1, turnId: "turn-alice" },
        resolutions: [
          {
            kind: "question",
            outcome: "answered",
            requestId: "ask-alice",
            response: { requestId: "ask-alice", text: "lantern" },
          },
        ],
      },
      {
        event: { sequence: 1, stepIndex: 2, turnId: "turn-bob" },
        resolutions: [
          {
            kind: "question",
            outcome: "answered",
            requestId: "ask-bob",
            response: { requestId: "ask-bob", text: "comet" },
          },
        ],
      },
    ]);
  });
});

describe("routeDeliverPayload message resolution", () => {
  function askSession(
    questions: ReadonlyArray<readonly [requestId: string, question: { allowFreeform?: boolean }]>,
  ): HarnessSession {
    let session = createSession();
    for (const [requestId, question] of questions) {
      session = upsertProxyInputRequests({
        entries: [
          [
            requestId,
            {
              workflowAsk: { control: `control-${requestId}` },
              reply: {
                ...question,
                options: [
                  { id: "1", label: "Staging" },
                  { id: "2", label: "Production" },
                ],
              },
              runId: `run-${requestId}`,
              childContinuationToken: `hook-${requestId}`,
              event: REQUEST_EVENT,
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
      state: askSession([["ask-1", {}]]).state,
    });

    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren).toMatchObject([
      {
        childContinuationToken: "hook-ask-1",
        payload: { inputResponses: [{ optionId: "2", requestId: "ask-1" }] },
        resolved: { resolutions: [{ outcome: "answered", requestId: "ask-1" }] },
      },
    ]);
  });

  it("drops a consumed message's context but keeps its channel state", () => {
    const routed = routeDeliverPayload({
      payload: {
        context: ["<telegram_context>\nmessage_id: 7\n</telegram_context>"],
        message: "production",
        state: { messageId: "7" },
      },
      resolveMessage: true,
      state: askSession([["ask-1", {}]]).state,
    });

    expect(routed.forSelf).toEqual({ state: { messageId: "7" } });
    expect(routed.forChildren[0]?.payload.inputResponses).toEqual([
      { optionId: "2", requestId: "ask-1" },
    ]);
  });

  it("answers the only pending question with free text when it allows it", () => {
    const routed = routeDeliverPayload({
      payload: { message: "Use the canary pool" },
      resolveMessage: true,
      state: askSession([["ask-1", { allowFreeform: true }]]).state,
    });

    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren[0]?.payload.inputResponses).toEqual([
      { requestId: "ask-1", text: "Use the canary pool" },
    ]);
  });

  it("answers the first of several pending questions", () => {
    const routed = routeDeliverPayload({
      payload: { message: "production" },
      resolveMessage: true,
      state: askSession([
        ["ask-1", {}],
        ["ask-2", {}],
      ]).state,
    });

    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren.map((child) => child.payload.inputResponses)).toEqual([
      [{ optionId: "2", requestId: "ask-1" }],
    ]);
  });

  it("keeps a message for the turn when it doesn't answer the first question", () => {
    const routed = routeDeliverPayload({
      payload: { message: "Actually, check the logs first." },
      resolveMessage: true,
      state: askSession([
        ["ask-1", {}],
        ["ask-2", { allowFreeform: true }],
      ]).state,
    });

    expect(routed.forSelf).toEqual({ message: "Actually, check the logs first." });
    expect(routed.forChildren).toEqual([]);
  });

  it("leaves a message for the turn while one of its approvals comes first", () => {
    const session = withParkedStep(askSession([["ask-1", { allowFreeform: true }]]), {
      requests: [
        {
          action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "deploy" },
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
          prompt: "Approve deploy?",
          requestId: "approval-1",
        },
      ],
    });
    const routed = routeDeliverPayload({
      payload: { message: "approve" },
      resolveMessage: true,
      state: session.state,
    });

    expect(routed.forSelf).toEqual({ message: "approve" });
    expect(routed.forChildren).toEqual([]);
  });

  it("does not answer a later question while a request it can't match comes first", () => {
    const session = upsertProxyInputRequests({
      entries: [
        [
          "ask-1",
          {
            workflowAsk: { control: "control-ask-1" },
            reply: { allowFreeform: true },
            childContinuationToken: "hook-ask-1",
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "hook-ask-1",
      session: upsertProxyInputRequests({
        entries: [
          [
            "child-ask",
            { childContinuationToken: "child-token", event: REQUEST_EVENT, kind: "question" },
          ],
        ],
        forChildContinuationToken: "child-token",
        session: createSession(),
      }),
    });
    const routed = routeDeliverPayload({
      payload: { message: "Use the canary pool" },
      resolveMessage: true,
      state: session.state,
    });

    expect(routed.forSelf).toEqual({ message: "Use the canary pool" });
    expect(routed.forChildren).toEqual([]);
  });

  function childPromptSession(requests: readonly InputRequest[]): HarnessSession {
    return upsertProxyInputRequests({
      entries: toProxyInputRequestEntries({
        callId: "call-1",
        childContinuationToken: "child-token",
        childSessionId: "child-session",
        event: { requests, ...REQUEST_EVENT },
        kind: "subagent-input-request",
        subagentName: "reviewer",
      }),
      forChildContinuationToken: "child-token",
      session: createSession(),
    });
  }

  function childPrompt(requestId: string, kind: InputRequest["kind"]): InputRequest {
    const options =
      kind === "session-limit"
        ? [
            { id: "continue", label: "Approve" },
            { id: "stop", label: "Stop" },
          ]
        : [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ];
    return {
      action: { callId: requestId, input: {}, kind: "tool-call", toolName: "deploy" },
      kind,
      options,
      prompt: "Continue?",
      requestId,
    };
  }

  it("answers a subagent's approvals one typed reply at a time", () => {
    const session = childPromptSession([
      childPrompt("approve-1", "tool-approval"),
      childPrompt("approve-2", "tool-approval"),
    ]);
    const first = routeDeliverPayload({
      payload: { message: "approve" },
      resolveMessage: true,
      state: session.state,
    });

    expect(first.forSelf).toBeUndefined();
    expect(first.forChildren).toMatchObject([
      {
        childContinuationToken: "child-token",
        message: "approve",
        payload: { inputResponses: [{ optionId: "approve", requestId: "approve-1" }] },
        // The child decides the approval; the parent closes it on the child's settlement.
        resolved: { resolutions: [] },
      },
    ]);

    // The child settled approve-1, which retires its route.
    const second = routeDeliverPayload({
      payload: { message: "cancel" },
      resolveMessage: true,
      state: retireProxyInputRequests(session, ["approve-1"]).state,
    });
    expect(second.forChildren).toMatchObject([
      {
        payload: { inputResponses: [{ optionId: "cancel", requestId: "approve-2" }] },
        resolved: { resolutions: [] },
      },
    ]);
  });

  it.each([
    ["continue", undefined],
    ["stop", { kind: "cancel-turn" }],
  ] as const)("routes a typed %s to a subagent's session-limit prompt", (reply, parentAction) => {
    const routed = routeDeliverPayload({
      payload: { message: reply },
      resolveMessage: true,
      state: childPromptSession([childPrompt("limit-1", "session-limit")]).state,
    });

    expect(routed.parentAction).toEqual(parentAction);
    expect(routed.forChildren[0]?.payload.inputResponses).toEqual([
      { optionId: reply, requestId: "limit-1" },
    ]);
  });

  it("answers the first of two children's prompts with a typed reply", () => {
    const session = upsertProxyInputRequests({
      entries: toProxyInputRequestEntries({
        callId: "call-2",
        childContinuationToken: "other-child-token",
        childSessionId: "other-child-session",
        event: { requests: [childPrompt("approve-other", "tool-approval")], ...REQUEST_EVENT },
        kind: "subagent-input-request",
        subagentName: "deployer",
      }),
      forChildContinuationToken: "other-child-token",
      session: childPromptSession([childPrompt("approve-1", "tool-approval")]),
    });
    const routed = routeDeliverPayload({
      payload: { message: "approve" },
      resolveMessage: true,
      state: session.state,
    });

    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren).toMatchObject([
      {
        childContinuationToken: "child-token",
        payload: { inputResponses: [{ optionId: "approve", requestId: "approve-1" }] },
      },
    ]);
  });

  it("leaves questions alone unless a person's message may resolve them", () => {
    const routed = routeDeliverPayload({
      payload: { message: "production" },
      state: askSession([["ask-1", {}]]).state,
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
      state: askSession([["ask-1", {}]]).state,
    });

    expect(routed.forSelf).toEqual({ message: "production" });
    expect(routed.forChildren[0]?.payload.inputResponses).toEqual([
      { optionId: "1", requestId: "ask-1" },
    ]);
  });
});
