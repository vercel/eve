import { describe, expect, it } from "vitest";
import {
  conversationReducer,
  reduceConversation,
  type ConversationEvent,
} from "#client/conversation-reducer.js";
import {
  agentCallTurns,
  isAgentSessionCaughtUp,
  type ConversationState,
} from "#client/conversation-state.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  createAgentStartedEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createMessageReceivedEvent,
  createSessionWaitingEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

let stamped = 0;
const stamp = (event: UnstampedMessageStreamEvent) => stampTestEvent(event, stamped++);

function reduce(
  state: ConversationState,
  events: readonly (UnstampedMessageStreamEvent | ConversationEvent)[],
): ConversationState {
  let current = state;
  for (const event of events) {
    current = reduceConversation(
      current,
      event.type.startsWith("client.")
        ? (event as ConversationEvent)
        : stamp(event as UnstampedMessageStreamEvent),
    );
  }
  return current;
}

/** Child events as the root's follower observes them. */
function observe(state: ConversationState, events: readonly UnstampedMessageStreamEvent[]) {
  return reduce(
    state,
    events.map((event) => ({
      type: "client.agent.observed" as const,
      data: { sessionId: "child", event: stamp(event) },
    })),
  );
}

const received = (turnId: string, message: string) =>
  createMessageReceivedEvent({ message, sequence: 0, turnId });
const turnStarted = (turnId: string) => createTurnStartedEvent({ sequence: 0, turnId });
const turnCompleted = (turnId: string) => createTurnCompletedEvent({ sequence: 0, turnId });
const call = (callId: string) =>
  createTaskStartedEvent({
    callId,
    kind: "agent",
    name: "researcher",
    taskId: "task_1",
    turnId: "root-turn",
  });
const settle = (callId: string) =>
  createTaskSettledEvent({
    callId,
    output: "done",
    status: "completed",
    taskId: "task_1",
    turnId: "root-turn",
  });

function followedResearcher(callIds: readonly string[]): ConversationState {
  return reduce(conversationReducer.initial(), [
    ...callIds.map(call),
    createAgentStartedEvent({
      callId: callIds[0]!,
      name: "researcher",
      parentSessionId: "root",
      sessionId: "child",
      taskId: "task_1",
      turnId: "root-turn",
    }),
    { type: "client.agent.following", data: { sessionId: "child" } },
  ]);
}

function child(state: ConversationState): ConversationState {
  const observation = state.agents.child?.observation;
  if (observation === undefined || observation.status === "not-followed") throw new Error();
  return observation.conversation!;
}

describe("agent tool sessions", () => {
  it("attributes each received message's turn to the task's calls in order", () => {
    const state = observe(followedResearcher(["a", "b", "c"]), [
      turnStarted("t1"),
      received("t1", "Find the March incidents."),
      received("t1", "Include the April ones too."),
      turnCompleted("t1"),
      // Resumed after an approval: no message of its own.
      turnStarted("t2"),
      turnCompleted("t2"),
      turnStarted("t3"),
      received("t3", "Now summarize them for Bob."),
    ]);
    expect(agentCallTurns(state.tasks.task_1!, child(state))).toEqual(
      new Map([
        ["a", ["t1", "t2"]],
        ["b", []],
        ["c", ["t3"]],
      ]),
    );
  });

  it("is caught up only once every call settled and its reply arrived", () => {
    let state = followedResearcher(["a"]);
    const caughtUp = () => isAgentSessionCaughtUp(state, state.agents.child!);
    expect(caughtUp()).toBe(false);
    // The root can report the call settled before the child's stream delivers the reply.
    state = reduce(state, [settle("a")]);
    expect(caughtUp()).toBe(false);
    state = observe(state, [turnStarted("t1"), received("t1", "Find the March incidents.")]);
    expect(caughtUp()).toBe(false);
    state = observe(state, [
      createInputRequestedEvent({
        requests: [
          {
            action: { callId: "lookup", input: {}, kind: "tool-call", toolName: "lookup" },
            kind: "tool-approval",
            prompt: "Approve Alice's lookup?",
            requestId: "q1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      turnCompleted("t1"),
    ]);
    expect(caughtUp()).toBe(false);
    state = observe(state, [
      {
        type: "input.resolved",
        data: {
          resolutions: [{ kind: "tool-approval", outcome: "approved", requestId: "q1" }],
          sequence: 0,
          stepIndex: 0,
          turnId: "t1",
        },
      },
    ]);
    expect(caughtUp()).toBe(true);
    // A sign-in parked after the reply resumes the agent's work once its callback arrives.
    const signIn = {
      attemptId: "attempt_1",
      name: "notes",
      sequence: 0,
      stepIndex: 0,
      turnId: "t1",
    };
    state = observe(state, [
      createAuthorizationRequiredEvent({
        ...signIn,
        description: "Connect Alice's notes",
        webhookUrl: "https://example.com/callback",
      }),
      createSessionWaitingEvent(),
    ]);
    expect(caughtUp()).toBe(false);
    state = observe(state, [
      createAuthorizationCompletedEvent({ ...signIn, outcome: "authorized" }),
    ]);
    expect(caughtUp()).toBe(true);
    state = reduce(state, [call("b")]);
    expect(caughtUp()).toBe(false);
  });
});
