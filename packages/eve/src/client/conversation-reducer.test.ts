import { describe, expect, it } from "vitest";
import { conversationReducer, reduceConversation } from "#client/conversation-reducer.js";
import { openConversationInputs } from "#client/conversation-state.js";
import { stampTestEvents } from "#internal/testing/events.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

function called(callId = "child-call", childSessionId = "child-session") {
  return stampTestEvents([
    {
      type: "subagent.called",
      data: {
        callId,
        childSessionId,
        childStreamPath: `/children/${callId}`,
        name: "researcher",
        sessionId: "root",
        turnId: "root-turn",
        sequence: 0,
        toolName: "agent",
        workflowId: "workflow",
      },
    } as UnstampedMessageStreamEvent,
  ])[0]!;
}

function request(requestId: string, turnId: string) {
  return stampTestEvents([
    {
      type: "input.requested",
      data: {
        requests: [
          {
            action: {
              callId: `tool-${requestId}`,
              input: {},
              kind: "tool-call",
              toolName: "lookup",
            },
            kind: "tool-approval",
            prompt: "Approve?",
            requestId,
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId,
      },
    } as UnstampedMessageStreamEvent,
  ])[0]!;
}

describe("conversation reducer child calls", () => {
  it("creates useful parent-only call state without inventing child details", () => {
    let state = conversationReducer.reduce(conversationReducer.initial(), called());
    expect(state.children["child-call"]).toMatchObject({
      name: "researcher",
      originTurnId: "root-turn",
      parentStatus: "dispatched",
      observation: { status: "not-followed" },
    });
    const receipt = stampTestEvents([
      {
        type: "action.result",
        data: {
          sequence: 1,
          stepIndex: 0,
          turnId: "root-turn",
          status: "completed",
          result: {
            kind: "tool-result",
            toolName: "agent",
            callId: "child-call",
            output: { status: "working", taskId: "task", agentId: "agent" },
          },
        },
      } as UnstampedMessageStreamEvent,
    ])[0]!;
    state = conversationReducer.reduce(state, receipt);
    expect(state.children["child-call"]).toMatchObject({
      background: true,
      parentStatus: "working",
      observation: { status: "not-followed" },
    });
  });

  it("keeps an unfollowed child's parent facts without synthesizing a child outcome", () => {
    let state = conversationReducer.reduce(conversationReducer.initial(), called());
    const completed = stampTestEvents([
      {
        type: "subagent.completed",
        data: { callId: "child-call", subagentName: "researcher", output: "done" },
      } as UnstampedMessageStreamEvent,
    ])[0]!;
    state = conversationReducer.reduce(state, completed);
    expect(state.children["child-call"]).toMatchObject({
      parentStatus: "reported-complete",
      observation: { status: "not-followed" },
    });
  });

  it("scopes root and child input IDs, and preserves child state through parent events", () => {
    let state = conversationReducer.reduce(conversationReducer.initial(), called());
    state = conversationReducer.reduce(state, request("same-id", "root-turn"));
    state = conversationReducer.reduce(state, {
      type: "client.child.following",
      data: { callId: "child-call" },
    });
    state = reduceConversation(state, {
      scope: "child",
      callId: "child-call",
      event: request("same-id", "child-turn"),
    });
    const child = state.children["child-call"]!;
    expect(child.observation.status).toBe("following");
    if (child.observation.status !== "following") return;
    expect(openConversationInputs(child.observation.conversation)).toHaveLength(1);
    expect(openConversationInputs(state)).toHaveLength(1);
    const settled = stampTestEvents([
      {
        type: "approval.settled",
        data: {
          outcome: "approved",
          requestId: "same-id",
          sequence: 0,
          stepIndex: 0,
          turnId: "root-turn",
        },
      } as UnstampedMessageStreamEvent,
    ])[0]!;
    state = conversationReducer.reduce(state, settled);
    expect(openConversationInputs(state)).toHaveLength(0);
    expect(state.children["child-call"]?.observation).toMatchObject({
      status: "following",
      conversation: { inputs: { "same-id": { status: "open" } } },
    });
  });

  it("distinguishes provisional parent completion from observed child closure", () => {
    let state = conversationReducer.reduce(conversationReducer.initial(), called());
    state = conversationReducer.reduce(state, {
      type: "client.child.following",
      data: { callId: "child-call" },
    });
    const completed = stampTestEvents([
      {
        type: "subagent.completed",
        data: { callId: "child-call", subagentName: "researcher", output: "done" },
      } as UnstampedMessageStreamEvent,
    ])[0]!;
    state = conversationReducer.reduce(state, completed);
    expect(state.children["child-call"]).toMatchObject({
      parentStatus: "reported-complete",
      observation: { status: "following" },
    });
    state = conversationReducer.reduce(state, {
      type: "client.child.ended",
      data: { callId: "child-call", outcome: "completed" },
    });
    expect(state.children["child-call"]?.observation).toMatchObject({
      status: "ended",
      outcome: "completed",
    });
  });

  it("cancels only foreground calls from the originating turn", () => {
    let state = conversationReducer.initial();
    state = conversationReducer.reduce(state, called("foreground"));
    state = conversationReducer.reduce(state, called("background"));
    const receipt = stampTestEvents([
      {
        type: "action.result",
        data: {
          sequence: 1,
          stepIndex: 0,
          turnId: "root-turn",
          status: "completed",
          result: {
            kind: "tool-result",
            toolName: "agent",
            callId: "background",
            output: { status: "working", taskId: "task", agentId: "agent" },
          },
        },
      } as UnstampedMessageStreamEvent,
    ])[0]!;
    state = conversationReducer.reduce(state, receipt);
    state = conversationReducer.reduce(
      state,
      stampTestEvents([
        {
          type: "turn.cancelled",
          data: { sequence: 2, turnId: "root-turn" },
        } as UnstampedMessageStreamEvent,
      ])[0]!,
    );
    expect(state.children.foreground).toMatchObject({
      parentStatus: "cancelled",
      observation: { status: "not-followed" },
    });
    expect(state.children.background?.observation.status).toBe("not-followed");
  });
});
