import { describe, expect, it } from "vitest";
import { initialConversationState, reduceConversation } from "#client/conversation-reducer.js";
import type { ConversationState } from "#client/conversation-state.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createAgentStartedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCancelledEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
  createTurnWaitingEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { Block } from "./blocks.js";
import { tuiSessionReducer, type AgentTUIConversationView } from "./conversation-view.js";
import { ConversationTranscript, turnActivity, type TranscriptOptions } from "./transcript.js";

const options: TranscriptOptions = {
  tools: "full",
  reasoning: "full",
  subagents: "full",
  connectionAuth: "full",
};

let stamp = 0;
function event(value: UnstampedMessageStreamEvent): EveAgentReducerEvent {
  return stampTestEvent(value, ++stamp);
}

function conversation(
  events: readonly EveAgentReducerEvent[],
  state: ConversationState = initialConversationState(),
): ConversationState {
  return events.reduce(reduceConversation, state);
}

function view(state: ConversationState, working: boolean): AgentTUIConversationView {
  return { conversation: state, working, data: tuiSessionReducer.initial(), failures: [] };
}

function byId(blocks: readonly Block[], id: string): Block | undefined {
  return blocks.find((block) => block.id === id);
}

const turn = event(createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }));

function toolCall(callId: string, toolName = "read_file") {
  return event(
    createActionsRequestedEvent({
      actions: [{ callId, input: { path: `${callId}.md` }, kind: "tool-call", toolName }],
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    }),
  );
}

function toolResult(callId: string, toolName = "read_file") {
  return event(
    createActionResultEvent({
      result: { callId, kind: "tool-result", output: "ok", toolName },
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_1",
    }),
  );
}

describe("ConversationTranscript", () => {
  it("keeps streaming prose live until its run completes", () => {
    const transcript = new ConversationTranscript();
    const streaming = conversation([
      turn,
      event(
        createMessageAppendedEvent({
          messageDelta: "Alice's report",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ),
    ]);
    expect(transcript.project(view(streaming, true), options)).toEqual([
      expect.objectContaining({ kind: "assistant", body: "Alice's report", live: true }),
    ]);

    const completed = conversation(
      [
        event(
          createMessageCompletedEvent({
            message: "Alice's report is ready.",
            sequence: 2,
            stepIndex: 0,
            turnId: "turn_1",
          }),
        ),
      ],
      streaming,
    );
    expect(transcript.project(view(completed, true), options)).toEqual([
      expect.objectContaining({ kind: "assistant", body: "Alice's report is ready.", live: false }),
    ]);
  });

  it("settles a stream that ended without its run completing", () => {
    const state = conversation([
      turn,
      event(
        createMessageAppendedEvent({
          messageDelta: "Partial",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ),
      toolCall("call_1"),
    ]);
    const blocks = new ConversationTranscript().project(view(state, false), options);
    expect(blocks.map((block) => block.live)).toEqual([false, false]);
    expect(byId(blocks, "tool:call_1")).toMatchObject({ status: "error", result: "interrupted" });
  });

  it("marks a cancelled turn after whatever it streamed", () => {
    const state = conversation([
      turn,
      event(
        createMessageAppendedEvent({
          messageDelta: "Half",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ),
      event(createTurnCancelledEvent({ sequence: 2, turnId: "turn_1" })),
    ]);
    expect(new ConversationTranscript().project(view(state, false), options)).toEqual([
      expect.objectContaining({ kind: "assistant", body: "Half", live: false }),
      expect.objectContaining({ kind: "notice", body: "Cancelled.", live: false }),
    ]);
  });

  it("holds a parallel tool cohort open until every call settles", () => {
    const transcript = new ConversationTranscript();
    const state = conversation([
      turn,
      toolCall("call_1"),
      toolCall("call_2"),
      toolResult("call_1"),
    ]);
    const blocks = transcript.project(view(state, true), options);
    expect(byId(blocks, "tool:call_1")).toMatchObject({ status: "done", live: true });
    expect(byId(blocks, "tool:call_2")).toMatchObject({ status: "running", live: true });

    const settled = transcript.project(
      view(conversation([toolResult("call_2")], state), true),
      options,
    );
    expect(settled.map((block) => [block.status, block.live])).toEqual([
      ["done", false],
      ["done", false],
    ]);
  });

  it("shows an approval as live until the user's answer, then denied without a result", () => {
    const requested = conversation([
      turn,
      event(
        createInputRequestedEvent({
          requests: [
            {
              action: {
                callId: "call_1",
                input: { path: "notes.md" },
                kind: "tool-call",
                toolName: "write_file",
              },
              kind: "tool-approval",
              prompt: "Approve write_file?",
              requestId: "approval_1",
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ),
    ]);
    const transcript = new ConversationTranscript();
    expect(byId(transcript.project(view(requested, false), options), "tool:call_1")).toMatchObject({
      status: "approval",
      live: true,
    });

    const denied = conversation(
      [
        {
          type: "client.input.responded",
          data: { createdAt: 0, responses: [{ requestId: "approval_1", optionId: "cancel" }] },
        },
      ],
      requested,
    );
    expect(byId(transcript.project(view(denied, true), options), "tool:call_1")).toMatchObject({
      status: "denied",
      live: false,
    });
  });

  it("settles a finished step's tools while a later step runs", () => {
    const state = conversation([
      turn,
      toolCall("call_1"),
      toolResult("call_1"),
      event(
        createActionsRequestedEvent({
          actions: [
            { callId: "call_2", input: { path: "b.md" }, kind: "tool-call", toolName: "read_file" },
          ],
          sequence: 3,
          stepIndex: 1,
          turnId: "turn_1",
        }),
      ),
    ]);
    const blocks = new ConversationTranscript().project(view(state, true), options);
    expect(byId(blocks, "tool:call_1")).toMatchObject({ status: "done", live: false });
    expect(byId(blocks, "tool:call_2")).toMatchObject({ status: "running", live: true });
  });

  it("keeps a task's tool row running past its receipt and names what a waiting turn holds on", () => {
    const state = conversation([
      turn,
      toolCall("call_1", "summarize"),
      toolResult("call_1", "summarize"),
      event(
        createTaskStartedEvent({
          callId: "call_1",
          name: "summarize",
          taskId: "task_1",
          turnId: "turn_1",
        }),
      ),
      event(createTurnWaitingEvent({ sequence: 3, turnId: "turn_1" })),
    ]);
    const working = view(state, true);
    expect(
      byId(new ConversationTranscript().project(working, options), "tool:call_1"),
    ).toMatchObject({
      status: "running",
      live: true,
    });
    expect(turnActivity(working)).toBe("Waiting on summarize");
  });

  it("renders each agent call over its own turns, live while its reply can still arrive", () => {
    const observe = (events: readonly UnstampedMessageStreamEvent[]) =>
      events.map((childEvent) => ({
        type: "client.agent.observed" as const,
        data: { sessionId: "child_1", event: event(childEvent) as MessageStreamEvent },
      }));
    const childReply = (turnId: string, message: string) =>
      observe([
        createTurnStartedEvent({ sequence: 0, turnId }),
        createMessageReceivedEvent({ message: `Question for ${turnId}`, sequence: 0, turnId }),
        createMessageCompletedEvent({ message, sequence: 0, stepIndex: 0, turnId }),
      ]);
    const settled = (callId: string) =>
      event(
        createTaskSettledEvent({
          callId,
          output: "done",
          status: "completed",
          taskId: "task_1",
          turnId: "turn_1",
        }),
      );
    const called = conversation([
      turn,
      toolCall("call_1", "research"),
      event(
        createTaskStartedEvent({
          callId: "call_1",
          name: "research",
          taskId: "task_1",
          turnId: "turn_1",
        }),
      ),
      event(
        createAgentStartedEvent({
          callId: "call_1",
          name: "research",
          parentSessionId: "session_1",
          sessionId: "child_1",
          taskId: "task_1",
          turnId: "turn_1",
        }),
      ),
      { type: "client.agent.following", data: { sessionId: "child_1" } },
      ...childReply("child_turn_1", "Bob's notes found."),
    ]);
    const transcript = new ConversationTranscript();
    expect(transcript.project(view(called, true), options)).toEqual([
      expect.objectContaining({ kind: "subagent", title: "research", live: true }),
      expect.objectContaining({ kind: "subagent-step", body: "Bob's notes found.", live: false }),
    ]);
    // The call can settle on the root before the agent's turn ends on its own stream.
    const reported = conversation([settled("call_1")], called);
    expect(transcript.project(view(reported, true), options)[0]).toMatchObject({
      kind: "subagent",
      status: "done",
      live: true,
    });
    const ended = conversation(
      observe([createTurnCompletedEvent({ sequence: 1, turnId: "child_turn_1" })]),
      reported,
    );
    expect(transcript.project(view(ended, true), options)[0]).toMatchObject({
      kind: "subagent",
      status: "done",
      live: false,
    });

    const continued = conversation(
      [
        toolCall("call_2", "research"),
        event(
          createTaskStartedEvent({
            callId: "call_2",
            name: "research",
            taskId: "task_1",
            turnId: "turn_1",
          }),
        ),
        ...childReply("child_turn_2", "Bob's summary is attached."),
      ],
      ended,
    );
    expect(
      transcript
        .project(view(continued, true), options)
        .map((block) => [block.kind, block.subtitle ?? block.body, block.live]),
    ).toEqual([
      ["subagent", "#1", false],
      ["subagent-step", "Bob's notes found.", false],
      ["subagent", "#2", true],
      ["subagent-step", "Bob's summary is attached.", false],
    ]);
    const failed = conversation(
      [
        event(
          createTaskSettledEvent({
            callId: "call_2",
            error: { message: "The agent's session ended." },
            status: "failed",
            taskId: "task_1",
            turnId: "turn_1",
          }),
        ),
        ...observe([
          createTurnFailedEvent({
            code: "MODEL_CALL_FAILED",
            message: "Unavailable.",
            sequence: 1,
            turnId: "child_turn_2",
          }),
        ]),
      ],
      continued,
    );
    expect(
      byId(transcript.project(view(failed, true), options), "subagent:call_2:header"),
    ).toMatchObject({
      status: "error",
      live: false,
    });
  });

  it("keeps same-name authorization attempts distinct and live until completed", () => {
    const required = (attemptId: string) =>
      event(
        createAuthorizationRequiredEvent({
          attemptId,
          authorization: { url: `https://idp.example.com/${attemptId}` },
          description: "Connect Linear",
          name: "linear",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
          webhookUrl: "https://agent.example.com/callback",
        }),
      );
    const state = conversation([
      turn,
      required("attempt_1"),
      required("attempt_2"),
      event(
        createAuthorizationCompletedEvent({
          attemptId: "attempt_1",
          name: "linear",
          outcome: "authorized",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ),
    ]);
    expect(new ConversationTranscript().project(view(state, true), options)).toEqual([
      expect.objectContaining({ title: "linear · authorization · authorized", live: false }),
      expect.objectContaining({ title: "linear · authorization · required", live: true }),
    ]);
  });

  it("keeps an optimistic message's block when the server confirms it", () => {
    const transcript = new ConversationTranscript();
    const optimistic = conversation([
      {
        type: "client.message.submitted",
        data: { createdAt: 0, message: "Summarize Alice's notes.", submissionId: "submission_1" },
      },
    ]);
    const [echo] = transcript.project(view(optimistic, true), options);

    const confirmed = conversation([
      event(
        createMessageReceivedEvent({
          message: "Summarize Alice's notes.",
          sequence: 0,
          turnId: "turn_1",
        }),
      ),
    ]);
    const blocks = transcript.project(view(confirmed, true), options);
    expect(blocks).toEqual([expect.objectContaining({ kind: "user", id: echo!.id })]);
  });

  it("renders each failure once with its hint and a pointer to the full detail", () => {
    const failures = [
      { message: "ModelError: rate limited", hint: "Retry later.", detail: "stack" },
    ];
    const blocks = new ConversationTranscript().project(
      { ...view(initialConversationState(), false), failures },
      { ...options, diagnosticsPath: ".eve/logs/dev.log" },
    );
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "error",
        body: "ModelError: rate limited",
        hint: "Retry later.",
        detail: "details: .eve/logs/dev.log",
      }),
    ]);
  });

  it("reuses unchanged blocks so the renderer can skip them", () => {
    const transcript = new ConversationTranscript();
    const state = conversation([turn, toolCall("call_1"), toolResult("call_1")]);
    const first = transcript.project(view(state, true), options);
    const again = transcript.project(view({ ...state }, true), options);
    expect(again[0]).toBe(first[0]);
  });
});
