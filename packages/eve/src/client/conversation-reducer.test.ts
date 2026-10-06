import { describe, expect, it } from "vitest";
import {
  conversationReducer,
  reduceConversation,
  type ConversationEvent,
} from "#client/conversation-reducer.js";
import { openConversationInputs, type ConversationState } from "#client/conversation-state.js";
import { TEST_USAGE, stampTestEvent } from "#internal/testing/events.js";
import {
  createAgentStartedEvent,
  createInputRequestedEvent,
  createStepStartedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  createTurnWaitingEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

let stamped = 0;

function reduce(
  events: readonly (UnstampedMessageStreamEvent | ConversationEvent)[],
  state: ConversationState = conversationReducer.initial(),
): ConversationState {
  let current = state;
  for (const event of events) {
    current = reduceConversation(
      current,
      event.type.startsWith("client.")
        ? (event as ConversationEvent)
        : stampTestEvent(event as UnstampedMessageStreamEvent, stamped++),
    );
  }
  return current;
}

function approval(requestId: string, turnId: string, taskId?: string) {
  return createInputRequestedEvent({
    requests: [
      {
        action: { callId: `tool-${requestId}`, input: {}, kind: "tool-call", toolName: "lookup" },
        kind: "tool-approval",
        prompt: "Approve Alice's lookup?",
        requestId,
      },
    ],
    sequence: 0,
    stepIndex: 0,
    taskId,
    turnId,
  });
}

const started = createAgentStartedEvent({
  callId: "call_1",
  name: "researcher",
  parentSessionId: "root",
  sessionId: "child",
  taskId: "task_1",
  turnId: "root-turn",
});

describe("conversation reducer tasks and agent sessions", () => {
  it("records each call to a task in order and settles it once", () => {
    const state = reduce([
      createTaskStartedEvent({
        callId: "call_1",
        kind: "agent",
        name: "researcher",
        taskId: "task_1",
        turnId: "t1",
      }),
      createTaskStartedEvent({
        callId: "call_2",
        kind: "agent",
        name: "researcher",
        taskId: "task_1",
        turnId: "t2",
      }),
      createTaskSettledEvent({
        callId: "call_1",
        output: "Bob's summary.",
        status: "completed",
        taskId: "task_1",
        turnId: "t1",
      }),
      createTaskSettledEvent({
        callId: "call_1",
        status: "cancelled",
        taskId: "task_1",
        turnId: "t1",
      }),
      createTaskSettledEvent({
        callId: "call_2",
        error: { message: "The agent's session ended." },
        status: "failed",
        taskId: "task_1",
        turnId: "t2",
      }),
      approval("req_1", "t2", "task_1"),
    ]);
    expect(state.tasks.task_1).toEqual({
      taskId: "task_1",
      name: "researcher",
      kind: "agent",
      calls: {
        call_1: { callId: "call_1", turnId: "t1", status: "completed", output: "Bob's summary." },
        call_2: {
          callId: "call_2",
          turnId: "t2",
          status: "failed",
          error: { message: "The agent's session ended." },
        },
      },
    });
    expect(Object.keys(state.tasks.task_1!.calls)).toEqual(["call_1", "call_2"]);
    expect(state.inputs.req_1).toMatchObject({ taskId: "task_1", status: "open" });
  });

  it("scopes session inputs apart from root inputs and keeps observed detail across pauses", () => {
    let state = reduce([
      started,
      approval("same-id", "root-turn"),
      { type: "client.agent.following", data: { sessionId: "child" } },
      {
        type: "client.agent.observed",
        data: { sessionId: "child", event: stampTestEvent(approval("same-id", "child-turn")) },
      },
    ]);
    expect(state.agents.child).toMatchObject({
      callId: "call_1",
      name: "researcher",
      taskId: "task_1",
      turnId: "root-turn",
      observation: { status: "following" },
    });
    expect(openConversationInputs(state)).toHaveLength(1);
    state = reduce(
      [
        {
          type: "approval.settled",
          data: {
            outcome: "approved",
            requestId: "same-id",
            responderPrincipalId: "alice",
            sequence: 0,
            stepIndex: 0,
            turnId: "root-turn",
          },
        },
        { type: "client.agent.idle", data: { sessionId: "child" } },
      ],
      state,
    );
    expect(openConversationInputs(state)).toHaveLength(0);
    const detail = { inputs: { "same-id": { status: "open" } } };
    expect(state.agents.child?.observation).toMatchObject({ status: "idle", conversation: detail });
    state = reduce([{ type: "client.agent.unavailable", data: { sessionId: "child" } }], state);
    expect(state.agents.child?.observation).toMatchObject({
      status: "unavailable",
      conversation: detail,
    });
    state = reduce([{ type: "client.agent.following", data: { sessionId: "child" } }], state);
    expect(state.agents.child?.observation).toMatchObject({
      status: "following",
      conversation: detail,
    });
  });

  it("marks a parked turn waiting until it resumes or ends", () => {
    const parked = reduce([
      createTurnStartedEvent({ sequence: 0, turnId: "t1" }),
      createTurnWaitingEvent({ on: "tasks", usage: TEST_USAGE, sequence: 0, turnId: "t1" }),
    ]);
    expect(parked.turns.t1).toEqual({
      status: "active",
      turnId: "t1",
      waiting: true,
    });
    expect(parked.activeTurnId).toBe("t1");
    const resumed = reduce(
      [createStepStartedEvent({ modelId: "mock", sequence: 0, stepIndex: 1, turnId: "t1" })],
      parked,
    );
    expect(resumed.turns.t1).toEqual({
      status: "active",
      turnId: "t1",
    });
    const ended = reduce(
      [
        createTurnWaitingEvent({ on: "tasks", usage: TEST_USAGE, sequence: 0, turnId: "t1" }),
        createTurnCompletedEvent({ sequence: 0, turnId: "t1" }),
      ],
      resumed,
    );
    expect(ended.turns.t1).toEqual({
      status: "completed",
      turnId: "t1",
    });
    expect(ended.activeTurnId).toBeUndefined();
  });
});
