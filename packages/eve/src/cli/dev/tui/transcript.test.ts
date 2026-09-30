import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  initialConversationState,
  reduceConversation,
  type ConversationEvent,
} from "#client/conversation-reducer.js";
import type { ConversationState } from "#client/conversation-state.js";
import { TEST_USAGE, stampTestEvent } from "#internal/testing/events.js";
import {
  createActionInputAppendedEvent,
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
function event(value: UnstampedMessageStreamEvent): MessageStreamEvent {
  return stampTestEvent(value, ++stamp);
}

function conversation(
  events: readonly ConversationEvent[],
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

function taskStarted(callId: string, name: string, taskId = "task_1") {
  return event(createTaskStartedEvent({ callId, kind: "agent", name, taskId, turnId: "turn_1" }));
}

function agentStarted(callId: string) {
  return event(
    createAgentStartedEvent({
      callId,
      name: "research",
      parentSessionId: "session_1",
      sessionId: "child_1",
      taskId: "task_1",
      turnId: "turn_1",
    }),
  );
}

function settled(callId: string) {
  return event(
    createTaskSettledEvent({
      callId,
      output: "done",
      status: "completed",
      taskId: "task_1",
      turnId: "turn_1",
    }),
  );
}

function parentText(message: string) {
  return event(
    createMessageCompletedEvent({ message, sequence: 4, stepIndex: 1, turnId: "turn_1" }),
  );
}

function observe(events: readonly UnstampedMessageStreamEvent[]): ConversationEvent[] {
  return events.map((childEvent) => ({
    type: "client.agent.observed" as const,
    data: { sessionId: "child_1", event: event(childEvent) },
  }));
}

function childReply(turnId: string, message: string): ConversationEvent[] {
  return observe([
    createTurnStartedEvent({ sequence: 0, turnId }),
    createMessageReceivedEvent({ message: `Question for ${turnId}`, sequence: 0, turnId }),
    createMessageCompletedEvent({ message, sequence: 0, stepIndex: 0, turnId }),
  ]);
}

/** Kind, task or agent name, and the line's detail, for reading placement at a glance. */
function summarize(blocks: readonly Block[]) {
  return blocks.map((block) => [block.kind, block.title ?? block.agentName, block.body]);
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

  it("writes a task's start line at its call and names the tasks a waiting turn holds on", () => {
    const state = conversation([
      turn,
      toolCall("call_1", "summarize"),
      taskStarted("call_1", "summarize"),
      toolResult("call_1", "summarize"),
      toolCall("wait_1", "task_wait"),
      event(
        createTurnWaitingEvent({ on: "tasks", usage: TEST_USAGE, sequence: 3, turnId: "turn_1" }),
      ),
    ]);
    const transcript = new ConversationTranscript();
    const working = view(state, true);
    expect(transcript.project(working, options)).toEqual([
      expect.objectContaining({
        id: "task:call_1:start",
        kind: "task",
        taskKind: "agent",
        title: "Delegate summarize",
        live: false,
      }),
    ]);
    expect(turnActivity(working, transcript.tasks)).toBe("Waiting for subagent(summarize)");
    // A root approval in the same step ends the turn while the task keeps working.
    expect(transcript.project(view(state, false), options)).toHaveLength(1);
    expect(transcript.tasks.map((task) => task.name)).toEqual(["summarize"]);
  });

  it("names the connection a session parked on a sign-in waits for", () => {
    const state = conversation([
      turn,
      event(
        createAuthorizationRequiredEvent({
          attemptId: "attempt_1",
          description: "Sign in to Linear",
          name: "linear",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
          webhookUrl: "https://example.com/callback",
        }),
      ),
      event(createTurnCompletedEvent({ sequence: 2, turnId: "turn_1" })),
    ]);
    expect(turnActivity(view(state, true), [])).toBe("Waiting for sign-in to Linear");
  });

  it("writes an agent's finished rows and end line where the transcript had reached, after its last events", () => {
    vi.useFakeTimers({ now: 0 });
    onTestFinished(() => void vi.useRealTimers());
    const called = conversation([
      turn,
      toolCall("call_1", "research"),
      taskStarted("call_1", "research"),
      agentStarted("call_1"),
      { type: "client.agent.following", data: { sessionId: "child_1" } },
      ...childReply("child_turn_1", "Bob's notes found."),
    ]);
    const transcript = new ConversationTranscript();
    expect(summarize(transcript.project(view(called, true), options))).toEqual([
      ["task", "Delegate research", undefined],
      ["subagent-step", "research", "Bob's notes found."],
    ]);
    expect(transcript.tasks[0]).toMatchObject({ name: "research", step: "Bob's notes found." });

    // The call can settle on the root before the agent's turn ends on its own stream.
    vi.setSystemTime(72_000);
    const reported = conversation([settled("call_1")], called);
    expect(transcript.project(view(reported, true), options)).toHaveLength(2);
    expect(transcript.tasks[0]).toMatchObject({ finishing: true });
    const ended = conversation(
      [
        ...observe([createTurnCompletedEvent({ sequence: 1, turnId: "child_turn_1" })]),
        parentText("Bob found his notes."),
      ],
      reported,
    );
    expect(summarize(transcript.project(view(ended, true), options))).toEqual([
      ["task", "Delegate research", undefined],
      ["subagent-step", "research", "Bob's notes found."],
      ["assistant", undefined, "Bob found his notes."],
      ["task", "research", "finished in 1min 12s"],
    ]);
    expect(transcript.tasks).toEqual([]);

    // A later call continuing the task writes its own lines after everything so far.
    const continued = conversation(
      [
        toolCall("call_2", "research"),
        taskStarted("call_2", "research"),
        ...childReply("child_turn_2", "Bob's summary is attached."),
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
      ended,
    );
    expect(summarize(transcript.project(view(continued, true), options)).slice(3)).toEqual([
      ["task", "research", "finished in 1min 12s"],
      ["task", "Delegate research", undefined],
      ["subagent-step", "research", "Bob's summary is attached."],
      ["task", "research", "failed · The agent's session ended."],
    ]);
  });

  it("follows nested background work without duplicating it as the owning agent's activity", () => {
    vi.useFakeTimers({ now: 0 });
    onTestFinished(() => void vi.useRealTimers());
    const started = conversation([
      turn,
      toolCall("call_1", "research"),
      taskStarted("call_1", "research"),
      agentStarted("call_1"),
      { type: "client.agent.following", data: { sessionId: "child_1" } },
      ...observe([
        createTurnStartedEvent({ sequence: 0, turnId: "child_turn" }),
        createMessageReceivedEvent({
          message: "Find Alice's notes",
          sequence: 0,
          turnId: "child_turn",
        }),
        createActionsRequestedEvent({
          actions: [
            {
              callId: "download",
              toolName: "download",
              kind: "tool-call",
              input: { file: "notes.md" },
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "child_turn",
        }),
        createTaskStartedEvent({
          callId: "download",
          taskId: "download_task",
          name: "download",
          kind: "tool",
          turnId: "child_turn",
        }),
      ]),
    ]);
    const transcript = new ConversationTranscript();
    transcript.project(view(started, true), options);
    expect(transcript.tasks[0]).toMatchObject({
      name: "research",
      children: [{ name: "download", kind: "tool", startedAtMs: 0 }],
    });
    expect(transcript.tasks[0]!.childTools.size).toBe(0);
    vi.setSystemTime(12_000);
    transcript.project(view(started, true), options);
    expect(transcript.tasks[0]!.children![0]!.startedAtMs).toBe(0);
    const finished = conversation(
      observe([
        createTaskSettledEvent({
          callId: "download",
          taskId: "download_task",
          turnId: "child_turn",
          status: "completed",
          output: "saved",
        }),
      ]),
      started,
    );
    transcript.project(view(finished, true), options);
    expect(transcript.tasks[0]!.children).toEqual([]);
    expect([...transcript.tasks[0]!.childTools.values()]).toEqual([
      expect.objectContaining({ status: "done" }),
    ]);
    transcript.project(view(started, true), { ...options, tools: "hidden" });
    expect(transcript.tasks[0]!.children).toEqual([]);
  });

  it("shares one nested projection budget across roots and reports omitted work", () => {
    const root = conversation([
      turn,
      toolCall("call_1", "research"),
      taskStarted("call_1", "research"),
      agentStarted("call_1"),
      toolCall("call_2", "review"),
      taskStarted("call_2", "review", "task_2"),
      event(
        createAgentStartedEvent({
          callId: "call_2",
          name: "review",
          parentSessionId: "session_1",
          sessionId: "child_2",
          taskId: "task_2",
          turnId: "turn_1",
        }),
      ),
    ]);
    const child = conversation([
      turn,
      event(
        createMessageReceivedEvent({
          message: "Process Alice's files",
          sequence: 0,
          turnId: "turn_1",
        }),
      ),
      ...Array.from({ length: 80 }, (_, i) => [
        toolCall(`call_${i}`, "download"),
        event(
          createTaskStartedEvent({
            callId: `call_${i}`,
            taskId: `task_${i}`,
            kind: "tool",
            name: "download",
            turnId: "turn_1",
          }),
        ),
      ]).flat(),
    ]);
    const withApproval = conversation(
      [
        event(
          createInputRequestedEvent({
            requests: [
              {
                requestId: "approve_download",
                kind: "tool-approval",
                prompt: "Approve download?",
                action: { callId: "call_79", toolName: "download", input: {}, kind: "tool-call" },
              },
            ],
            turnId: "turn_1",
            sequence: 2,
            stepIndex: 0,
          }),
        ),
      ],
      child,
    );
    const observed = {
      ...withApproval,
      inputs: {
        ...withApproval.inputs,
        approve_download: { ...withApproval.inputs.approve_download!, taskId: "task_79" },
      },
    };
    const state: ConversationState = {
      ...root,
      agents: Object.fromEntries(
        Object.entries(root.agents).map(([id, agent]) => [
          id,
          { ...agent, observation: { status: "following", conversation: observed } },
        ]),
      ),
    };
    const transcript = new ConversationTranscript();
    transcript.project(view(state, true), options);
    expect(transcript.tasks.map((task) => task.children?.length)).toEqual([80, 48]);
    expect(transcript.tasks.map((task) => task.omittedTasks)).toEqual([0, 32]);
    expect(transcript.tasks[1]!.omittedAttention).toBe(true);
  });

  it("names parallel calls apart, stops tasks a cancelled turn leaves working, and hides hidden ones", () => {
    const state = conversation([
      turn,
      toolCall("call_1", "research"),
      taskStarted("call_1", "research"),
      toolCall("call_2", "research"),
      taskStarted("call_2", "research", "task_2"),
    ]);
    const transcript = new ConversationTranscript();
    const starts = transcript.project(view(state, true), options);
    expect(starts.map((block) => block.title)).toEqual([
      "Delegate research",
      "Delegate research #2",
    ]);
    expect(transcript.tasks.map((task) => task.name)).toEqual(["research", "research #2"]);
    // An input request names the task that asked as its lines do.
    expect(transcript.taskLabel(state, "task_2")).toBe("research #2");

    const cancelled = conversation(
      [event(createTurnCancelledEvent({ sequence: 3, turnId: "turn_1" }))],
      state,
    );
    const ends = transcript
      .project(view(cancelled, false), options)
      .filter((block) => block.id?.endsWith(":end"));
    expect(ends.map((block) => [block.title, block.status, block.body])).toEqual([
      ["research", "denied", "stopped"],
      ["research #2", "denied", "stopped"],
    ]);
    expect(transcript.tasks).toEqual([]);

    const hidden = new ConversationTranscript();
    expect(hidden.project(view(state, true), { ...options, subagents: "hidden" })).toEqual([]);
    expect(hidden.tasks).toEqual([]);
  });

  it("hides refused calls, shows authored labels, and holds a placeholder while input streams", () => {
    const events = [
      turn,
      event(
        createActionsRequestedEvent({
          actions: [
            { callId: "call_1", input: { city: "Paris" }, kind: "tool-call", toolName: "weather" },
          ],
          presentation: { call_1: { label: "Checking the weather" } },
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ),
      toolCall("call_2", "research"),
      event(
        createActionResultEvent({
          result: {
            callId: "call_2",
            isError: true,
            kind: "tool-result",
            output: { code: "TOO_MANY_TASKS", message: "Wait for a task to finish." },
            toolName: "research",
          },
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ),
      event(
        createActionInputAppendedEvent({
          callId: "call_3",
          inputTextDelta: "{",
          sequence: 3,
          stepIndex: 1,
          toolName: "read_file",
          turnId: "turn_1",
        }),
      ),
    ];
    const state = conversation(events);
    const data = events.reduce(tuiSessionReducer.reduce, tuiSessionReducer.initial());
    const project = (working: boolean) =>
      new ConversationTranscript()
        .project({ conversation: state, working, data, failures: [] }, options)
        .map((block) => [block.id, block.title]);
    expect(project(true)).toEqual([
      ["tool:call_1", "Checking the weather"],
      ["tool:call_3", "Read …"],
    ]);
    expect(project(false)).toEqual([["tool:call_1", "Checking the weather"]]);
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
    const received = event(
      createMessageReceivedEvent({
        message: "Summarize Alice's notes.",
        sequence: 0,
        turnId: "turn_1",
      }),
    );
    const echoOnly = [expect.objectContaining({ kind: "user", id: echo!.id })];

    // The server's copy can arrive before the store swaps out the optimistic message.
    expect(transcript.project(view(conversation([received], optimistic), true), options)).toEqual(
      echoOnly,
    );
    expect(transcript.project(view(conversation([received]), true), options)).toEqual(echoOnly);
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
