import { describe, expect, it } from "vitest";

import { defaultMessageReducer } from "#client/message-reducer.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createActionInputAppendedEvent,
  createActionPartialEvent,
  createActionResultEvent,
  createActionsRequestedEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputResolvedEvent,
  createInputRequestedEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createReasoningAppendedEvent,
  createReasoningCompletedEvent,
  createResultCompletedEvent,
  createSessionWaitingEvent,
  createStepStartedEvent,
  createTaskEndedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCancelledEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

function reduceServerEvents(
  reducer: ReturnType<typeof defaultMessageReducer>,
  data: ReturnType<ReturnType<typeof defaultMessageReducer>["initial"]>,
  events: readonly UnstampedMessageStreamEvent[],
) {
  let next = data;
  for (const event of stampTestEvents(events)) {
    next = reducer.reduce(next, event);
  }
  return next;
}

describe("defaultMessageReducer", () => {
  it("keeps a held turn in one assistant message across its waiting boundaries", () => {
    // Alice's turn holds on a lookup: an interim answer, her follow-up in the
    // same turn, then the result and the final answer, all under turn_0.
    const reducer = defaultMessageReducer();
    const turn = { sequence: 0, turnId: "turn_0" };
    const answer = (message: string, stepIndex: number) =>
      createMessageCompletedEvent({ ...turn, finishReason: "stop", message, stepIndex });
    const events = [
      createMessageReceivedEvent({ ...turn, message: "What were Q3 sales?" }),
      answer("I started a lookup.", 0),
      createSessionWaitingEvent(),
      createMessageReceivedEvent({ ...turn, message: "Any news?" }),
      answer("Still working on it.", 1),
      createSessionWaitingEvent(),
      createMessageReceivedEvent({ ...turn, message: "<task_result/>", taskIds: ["lookup-1"] }),
      answer("Q3 sales were $4.2M.", 2),
      createTurnCompletedEvent(turn),
      createSessionWaitingEvent(),
    ];
    // The turn is open to input but not over: its later output joins this message.
    const held = reduceServerEvents(reducer, reducer.initial(), events.slice(0, 3));
    expect(held.messages.at(-1)).toMatchObject({
      id: "turn_0:assistant",
      parts: [{ type: "step-start" }, { state: "done", text: "I started a lookup." }],
    });

    const data = reduceServerEvents(reducer, reducer.initial(), events);
    expect(
      data.messages.map((message) => ({
        id: message.id,
        role: message.role,
        status: message.metadata?.status,
        text: message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      })),
    ).toEqual([
      expect.objectContaining({ role: "user", text: ["What were Q3 sales?"] }),
      {
        id: "turn_0:assistant",
        role: "assistant",
        status: "complete",
        text: ["I started a lookup.", "Still working on it.", "Q3 sales were $4.2M."],
      },
      expect.objectContaining({ role: "user", text: ["Any news?"] }),
    ]);
  });

  it("finalizes a held turn cancelled after its waiting boundary", () => {
    const reducer = defaultMessageReducer();
    const turn = { sequence: 0, turnId: "turn_0" };
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createMessageCompletedEvent({ ...turn, message: "I started a lookup.", stepIndex: 0 }),
      createSessionWaitingEvent(),
      createMessageAppendedEvent({ ...turn, messageDelta: "Checking", stepIndex: 1 }),
      createTurnCancelledEvent(turn),
    ]);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({
      id: "turn_0:assistant",
      metadata: { status: "complete" },
      parts: expect.arrayContaining([
        { state: "done", stepIndex: 0, text: "I started a lookup.", type: "text" },
        { state: "done", stepIndex: 1, text: "Checking", type: "text" },
      ]),
    });
  });

  it("accumulates message and reasoning deltas without a start marker", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createReasoningAppendedEvent({
        reasoningDelta: "I",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createReasoningAppendedEvent({
        reasoningDelta: " can",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createMessageAppendedEvent({
        messageDelta: "Hel",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createMessageAppendedEvent({
        messageDelta: "lo",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages[0]?.parts).toEqual([
      { type: "step-start" },
      { state: "streaming", stepIndex: 0, text: "I can", type: "reasoning" },
      { state: "streaming", stepIndex: 0, text: "Hello", type: "text" },
    ]);
  });

  it("uses the canonical completion after an interrupted attempt", () => {
    const reducer = defaultMessageReducer();
    let data = reduceServerEvents(reducer, reducer.initial(), [
      createMessageAppendedEvent({
        messageDelta: "abandoned",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createMessageAppendedEvent({
        messageDelta: "replacement",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createMessageAppendedEvent({
        messageDelta: " complete",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages[0]?.parts).toContainEqual({
      state: "streaming",
      stepIndex: 0,
      text: "abandonedreplacement complete",
      type: "text",
    });

    data = reduceServerEvents(reducer, data, [
      createMessageCompletedEvent({
        message: "replacement complete",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages[0]?.parts).toContainEqual({
      state: "done",
      stepIndex: 0,
      text: "replacement complete",
      type: "text",
    });
  });

  it("projects streamed tool input and upgrades it to the validated request", () => {
    const reducer = defaultMessageReducer();
    let data = reduceServerEvents(reducer, reducer.initial(), [
      createActionInputAppendedEvent({
        callId: "call_render",
        inputTextDelta: "",
        sequence: 1,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_1",
      }),
      createActionInputAppendedEvent({
        callId: "call_render",
        inputTextDelta: '{"title":"Hel',
        sequence: 1,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages[0]?.parts).toContainEqual({
      input: undefined,
      inputText: '{"title":"Hel',
      state: "input-streaming",
      stepIndex: 0,
      toolCallId: "call_render",
      toolMetadata: { eve: { kind: "unknown", name: "render" } },
      toolName: "render",
      type: "dynamic-tool",
    });

    data = reduceServerEvents(reducer, data, [
      createActionInputAppendedEvent({
        callId: "call_render",
        inputTextDelta: 'lo"}',
        sequence: 1,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_1",
      }),
    ]);
    expect(data.messages[0]?.parts).toContainEqual(
      expect.objectContaining({ inputText: '{"title":"Hello"}' }),
    );

    data = reduceServerEvents(reducer, data, [
      createActionsRequestedEvent({
        actions: [
          {
            callId: "call_render",
            input: { title: "Hello" },
            kind: "tool-call",
            toolName: "render",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages[0]?.parts).toContainEqual({
      input: { title: "Hello" },
      state: "input-available",
      stepIndex: 0,
      toolCallId: "call_render",
      toolMetadata: { eve: { inputRequest: undefined, kind: "tool-call", name: "render" } },
      toolName: "render",
      type: "dynamic-tool",
    });

    const settled = data;
    data = reduceServerEvents(reducer, data, [
      createActionInputAppendedEvent({
        callId: "call_render",
        inputTextDelta: "late",
        sequence: 1,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_1",
      }),
    ]);
    expect(data).toBe(settled);
  });

  it("tracks each task generation on the tool part of the call that started it", () => {
    // Alice's writer drafts, then revises after her send with its taskId.
    const reducer = defaultMessageReducer();
    const turn = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
    const call = (callId: string, input: Record<string, string>) =>
      createActionsRequestedEvent({
        ...turn,
        actions: [{ callId, input, kind: "tool-call", toolName: "writer" }],
      });
    const started = (callId: string, generation: number) =>
      createTaskStartedEvent({
        callId,
        child: { sessionId: "child_1" },
        generation,
        kind: "agent",
        mode: "detached",
        name: "writer",
        parentSessionId: "session_1",
        resumable: true,
        taskId: "writer-abc234",
        turnId: "turn_0",
      });
    const settled = (callId: string, generation: number) =>
      createTaskSettledEvent({
        callId,
        generation,
        output: `draft ${generation}`,
        status: "completed",
        taskId: "writer-abc234",
      });
    const taskOn = (data: ReturnType<typeof reducer.initial>, callId: string) =>
      data.messages
        .flatMap((message) => message.parts)
        .flatMap((part) =>
          part.type === "dynamic-tool" && part.toolCallId === callId ? [part] : [],
        )
        .at(0)?.toolMetadata?.eve?.task;

    let data = reduceServerEvents(reducer, reducer.initial(), [
      call("call_1", { message: "Draft it." }),
      started("call_1", 1),
    ]);
    expect(taskOn(data, "call_1")).toEqual({
      generation: 1,
      id: "writer-abc234",
      status: "working",
    });

    data = reduceServerEvents(reducer, data, [
      settled("call_1", 1),
      call("call_2", { message: "Shorter, please.", taskId: "writer-abc234" }),
      started("call_2", 2),
    ]);
    expect(taskOn(data, "call_1")).toEqual({
      generation: 1,
      id: "writer-abc234",
      status: "completed",
    });
    expect(taskOn(data, "call_2")).toEqual({
      generation: 2,
      id: "writer-abc234",
      status: "working",
    });

    // A repeated start or a settle for another generation leaves the part as it is.
    const repeated = reduceServerEvents(reducer, data, [
      started("call_2", 2),
      settled("call_2", 1),
    ]);
    expect(taskOn(repeated, "call_2")).toEqual(taskOn(data, "call_2"));

    data = reduceServerEvents(reducer, repeated, [
      settled("call_2", 2),
      createTaskEndedEvent("writer-abc234"),
    ]);
    expect(taskOn(data, "call_1")).toMatchObject({ ended: true, generation: 1 });
    expect(taskOn(data, "call_2")).toEqual({
      ended: true,
      generation: 2,
      id: "writer-abc234",
      status: "completed",
    });
  });

  it("keeps a reused call ID's task on the part of the turn that started it", () => {
    // The model names its call call_1 in both of Bob's turns: the second is a
    // send that starts the writer's next generation.
    const reducer = defaultMessageReducer();
    const call = (turnId: string, sequence: number) =>
      createActionsRequestedEvent({
        actions: [
          {
            callId: "call_1",
            input: { message: "Draft it." },
            kind: "tool-call",
            toolName: "writer",
          },
        ],
        sequence,
        stepIndex: 0,
        turnId,
      });
    const started = (generation: number, turnId: string) =>
      createTaskStartedEvent({
        callId: "call_1",
        generation,
        kind: "agent",
        mode: "detached",
        name: "writer",
        parentSessionId: "session_1",
        resumable: true,
        taskId: "writer-aaaaaa",
        turnId,
      });
    const data = reduceServerEvents(reducer, reducer.initial(), [
      call("turn_0", 0),
      started(1, "turn_0"),
      createTaskSettledEvent({
        callId: "call_1",
        generation: 1,
        output: "first",
        status: "completed",
        taskId: "writer-aaaaaa",
      }),
      call("turn_1", 1),
      started(2, "turn_1"),
    ]);

    const tasks = data.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "dynamic-tool"
          ? [[message.metadata?.turnId, part.toolMetadata?.eve?.task] as const]
          : [],
      ),
    );
    expect(tasks).toEqual([
      ["turn_0", { generation: 1, id: "writer-aaaaaa", status: "completed" }],
      ["turn_1", { generation: 2, id: "writer-aaaaaa", status: "working" }],
    ]);
  });

  it("skips task events for calls with no tool part", () => {
    const reducer = defaultMessageReducer();
    const initial = reducer.initial();
    const data = reduceServerEvents(reducer, initial, [
      createTaskSettledEvent({
        callId: "ctx-agent-1",
        generation: 1,
        status: "cancelled",
        taskId: "writer-abc234",
      }),
      createTaskEndedEvent("writer-abc234"),
    ]);
    expect(data).toBe(initial);
  });

  it("projects workflow tool requests as named tool parts", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createActionsRequestedEvent({
        actions: [
          {
            callId: "call_publish",
            input: { report: "weekly" },
            kind: "workflow-tool-call",
            toolName: "publish",
            workflowId: "publish-workflow",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages[0]?.parts).toContainEqual({
      input: { report: "weekly" },
      state: "input-available",
      stepIndex: 0,
      toolCallId: "call_publish",
      toolMetadata: {
        eve: { inputRequest: undefined, kind: "tool-call", name: "publish" },
      },
      toolName: "publish",
      type: "dynamic-tool",
    });
  });

  it("removes an unfinished streamed tool input when the turn is cancelled", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createActionInputAppendedEvent({
        callId: "call_render",
        inputTextDelta: "{",
        sequence: 1,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_1",
      }),
      createTurnCancelledEvent({ sequence: 1, turnId: "turn_1" }),
    ]);

    expect(data.messages[0]?.parts).toEqual([{ type: "step-start" }]);
  });

  it("does not create an assistant message when a turn fails before streaming", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createTurnFailedEvent({
        code: "MODEL_FAILED",
        message: "model failed",
        sequence: 1,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages).toEqual([]);
  });

  it("replaces tool-generator snapshots and ignores a late partial after the terminal result", () => {
    const reducer = defaultMessageReducer();
    let data = reduceServerEvents(reducer, reducer.initial(), [
      createActionsRequestedEvent({
        actions: [
          {
            callId: "call_1",
            input: { project: "eve" },
            kind: "tool-call",
            toolName: "build_report",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createActionPartialEvent({
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: { phase: "collecting" },
          toolName: "build_report",
        },
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createActionPartialEvent({
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: { phase: "writing" },
          toolName: "build_report",
        },
        sequence: 3,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(findToolPart(data, "call_1")).toMatchObject({
      output: { phase: "writing" },
      partial: true,
      state: "output-available",
    });

    data = reduceServerEvents(reducer, data, [
      createActionResultEvent({
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: { phase: "complete" },
          toolName: "build_report",
        },
        sequence: 4,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createActionPartialEvent({
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: { phase: "stale" },
          toolName: "build_report",
        },
        sequence: 5,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    const terminal = findToolPart(data, "call_1");
    expect(terminal).toMatchObject({
      output: { phase: "complete" },
      state: "output-available",
    });
    expect(terminal).not.toHaveProperty("partial");
  });

  it("projects messages, reasoning, and actions into UIMessage-compatible parts", () => {
    const reducer = defaultMessageReducer();
    let data = reducer.initial();

    data = reducer.reduce(data, {
      data: {
        createdAt: 1,
        message: "Weather in Vienna?",
        submissionId: "submission_1",
      },
      type: "client.message.submitted",
    });
    data = reduceServerEvents(reducer, data, [
      createReasoningCompletedEvent({
        reasoning: "Need the weather tool.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createActionsRequestedEvent({
        actions: [
          {
            callId: "call_1",
            input: { city: "Vienna" },
            kind: "tool-call",
            toolName: "get_weather",
          },
        ],
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createActionResultEvent({
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: { forecast: "sunny" },
          toolName: "get_weather",
        },
        sequence: 3,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages).toEqual([
      {
        id: "optimistic:submission_1:user",
        metadata: {
          optimistic: true,
          status: "submitted",
        },
        parts: [{ text: "Weather in Vienna?", type: "text" }],
        role: "user",
      },
      {
        id: "turn_1:assistant",
        metadata: {
          status: "streaming",
          turnId: "turn_1",
        },
        parts: [
          { type: "step-start" },
          {
            state: "done",
            stepIndex: 0,
            text: "Need the weather tool.",
            type: "reasoning",
          },
          {
            input: { city: "Vienna" },
            output: { forecast: "sunny" },
            state: "output-available",
            stepIndex: 0,
            toolCallId: "call_1",
            toolMetadata: {
              eve: {
                kind: "tool-call",
                name: "get_weather",
              },
            },
            toolName: "get_weather",
            type: "dynamic-tool",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("projects an action result without a preceding action request", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createActionResultEvent({
        result: {
          callId: "call_1",
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "terminal",
            result: { kind: "succeeded", output: { summary: "done" } },
            usageDelta: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          },
          output: { summary: "done" },
          subagentName: "research",
        },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages).toEqual([
      {
        id: "turn_1:assistant",
        metadata: {
          status: "streaming",
          turnId: "turn_1",
        },
        parts: [
          { type: "step-start" },
          {
            input: undefined,
            output: { summary: "done" },
            state: "output-available",
            stepIndex: 0,
            toolCallId: "call_1",
            toolMetadata: {
              eve: {
                kind: "subagent-call",
                name: "research",
              },
            },
            toolName: "eve:subagent:research",
            type: "dynamic-tool",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("projects denied tool output distinctly from generic failures", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createActionResultEvent({
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: JSON.stringify({
            code: "TOOL_EXECUTION_DENIED",
            message: "Tool execution was denied.",
          }),
          toolName: "bash",
        },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages).toEqual([
      {
        id: "turn_1:assistant",
        metadata: {
          status: "streaming",
          turnId: "turn_1",
        },
        parts: [
          { type: "step-start" },
          {
            approval: {
              approved: false,
              id: "call_1",
              reason: "Tool execution was denied.",
            },
            input: undefined,
            state: "output-denied",
            stepIndex: 0,
            toolCallId: "call_1",
            toolMetadata: {
              eve: {
                kind: "tool-call",
                name: "bash",
              },
            },
            toolName: "bash",
            type: "dynamic-tool",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("stores completed structured results on assistant metadata", () => {
    const reducer = defaultMessageReducer();
    let data = reducer.initial();

    data = reduceServerEvents(reducer, data, [
      createResultCompletedEvent({
        result: { title: "Done" },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages).toEqual([
      {
        id: "turn_1:assistant",
        metadata: {
          result: { title: "Done" },
          status: "streaming",
          turnId: "turn_1",
        },
        parts: [],
        role: "assistant",
      },
    ]);
  });

  it("projects authorization prompts into assistant message parts", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createAuthorizationRequiredEvent({
        authorization: {
          expiresAt: "2026-06-26T12:00:00.000Z",
          instructions: "Sign in to Notion to continue.",
          url: "https://connect.example.com/authorize/sca_123",
          userCode: "ABCD-EFGH",
        },
        description: "Authorization required for notion",
        name: "notion",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
        webhookUrl: "https://agent.example.com/eve/v1/connections/notion/callback/hook",
      }),
    ]);

    expect(data.messages).toEqual([
      {
        id: "turn_1:assistant",
        metadata: {
          status: "streaming",
          turnId: "turn_1",
        },
        parts: [
          { type: "step-start" },
          {
            authorization: {
              expiresAt: "2026-06-26T12:00:00.000Z",
              instructions: "Sign in to Notion to continue.",
              url: "https://connect.example.com/authorize/sca_123",
              userCode: "ABCD-EFGH",
            },
            description: "Authorization required for Notion",
            displayName: "Notion",
            name: "notion",
            state: "required",
            stepIndex: 0,
            turnId: "turn_1",
            type: "authorization",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("updates the pending authorization part when authorization completes", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createAuthorizationRequiredEvent({
        authorization: {
          displayName: "Notion",
          instructions: "Sign in to Notion to continue.",
          url: "https://connect.example.com/authorize/sca_123",
        },
        description: "Sign in to Notion to continue.",
        name: "notion",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
        webhookUrl: "https://agent.example.com/eve/v1/connections/notion/callback/hook",
      }),
      createAuthorizationCompletedEvent({
        authorization: {
          displayName: "Notion",
          url: "https://connect.example.com/authorize/sca_123",
        },
        name: "notion",
        outcome: "authorized",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_2",
      }),
    ]);

    expect(data.messages).toEqual([
      {
        id: "turn_1:assistant",
        metadata: {
          status: "streaming",
          turnId: "turn_1",
        },
        parts: [
          { type: "step-start" },
          {
            authorization: {
              displayName: "Notion",
              instructions: "Sign in to Notion to continue.",
              url: "https://connect.example.com/authorize/sca_123",
            },
            description: "Sign in to Notion to continue.",
            displayName: "Notion",
            name: "notion",
            outcome: "authorized",
            state: "completed",
            stepIndex: 0,
            turnId: "turn_1",
            type: "authorization",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("projects input requests onto tool approval parts", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createInputRequestedEvent({
        requests: [
          {
            action: {
              callId: "call_1",
              input: { command: "pwd" },
              kind: "tool-call",
              toolName: "bash",
            },
            display: "confirmation",
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Yes", style: "primary" },
              { id: "deny", label: "No", style: "danger" },
            ],
            prompt: "Approve tool call: bash",
            requestId: "approval_1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages).toEqual([
      {
        id: "turn_1:assistant",
        metadata: {
          status: "streaming",
          turnId: "turn_1",
        },
        parts: [
          { type: "step-start" },
          {
            approval: {
              id: "approval_1",
            },
            input: { command: "pwd" },
            state: "approval-requested",
            stepIndex: 0,
            toolCallId: "call_1",
            toolMetadata: {
              eve: {
                inputRequest: {
                  allowFreeform: undefined,
                  display: "confirmation",
                  kind: "tool-approval",
                  options: [
                    { id: "approve", label: "Yes", style: "primary" },
                    { id: "deny", label: "No", style: "danger" },
                  ],
                  prompt: "Approve tool call: bash",
                  requestId: "approval_1",
                },
                kind: "tool-call",
                name: "bash",
              },
            },
            toolName: "bash",
            type: "dynamic-tool",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("keeps an older approval answerable after a later turn", () => {
    const reducer = defaultMessageReducer();
    let data = reduceServerEvents(reducer, reducer.initial(), [
      createInputRequestedEvent({
        requests: [
          {
            action: {
              callId: "call_1",
              input: { command: "pwd" },
              kind: "tool-call",
              toolName: "bash",
            },
            display: "confirmation",
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Yes", style: "primary" },
              { id: "cancel", label: "No", style: "danger" },
            ],
            prompt: "Approve tool call: bash",
            requestId: "approval_1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      {
        data: { message: "What time is it?", sequence: 0, turnId: "turn_2" },
        type: "message.received",
      },
      createMessageCompletedEvent({
        message: "It is noon.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_2",
      }),
    ]);

    expect(data.messages.at(-1)?.id).toBe("turn_2:assistant");
    expect(findToolPart(data, "call_1")).toMatchObject({ state: "approval-requested" });

    data = reducer.reduce(data, {
      data: {
        createdAt: 1,
        responses: [{ optionId: "approve", requestId: "approval_1" }],
      },
      type: "client.input.responded",
    });

    expect(findToolPart(data, "call_1")).toMatchObject({ state: "approval-requested" });
  });

  it.each(["tool-approval", "question", "session-limit"] as const)(
    "waits for authoritative resolution of a submitted %s response",
    (kind) => {
      const reducer = defaultMessageReducer();
      const requested = reduceServerEvents(reducer, reducer.initial(), [
        createInputRequestedEvent({
          requests: [
            {
              action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
              kind,
              prompt: "Continue Alice's task?",
              requestId: "request_1",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ]);
      const response = { requestId: "request_1", optionId: "continue" };
      const submitted = reducer.reduce(requested, {
        type: "client.input.responded",
        data: { createdAt: 1, responses: [response] },
      });
      expect(submitted).toBe(requested);
      expect(findToolPart(submitted, "call_1")).toMatchObject({ state: "approval-requested" });
      expect(findToolPart(submitted, "call_1")?.toolMetadata?.eve?.inputResponse).toBeUndefined();
      const resolved = reduceServerEvents(reducer, submitted, [
        createInputResolvedEvent({
          resolutions: [
            {
              kind,
              outcome: kind === "tool-approval" ? "approved" : "answered",
              requestId: "request_1",
              response,
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ]);
      expect(findToolPart(resolved, "call_1")).toMatchObject({
        state: "approval-responded",
        toolMetadata: { eve: { inputResponse: response } },
      });
    },
  );

  it("projects authoritative input resolutions from replayed server events", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createInputRequestedEvent({
        requests: [
          {
            action: {
              callId: "call_1",
              input: { command: "pwd" },
              kind: "tool-call",
              toolName: "bash",
            },
            display: "confirmation",
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Yes", style: "primary" },
              { id: "cancel", label: "No", style: "danger" },
            ],
            prompt: "Approve tool call: bash",
            requestId: "approval_1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createInputResolvedEvent({
        resolutions: [
          {
            kind: "tool-approval",
            outcome: "approved",
            requestId: "approval_1",
            response: { optionId: "approve", requestId: "approval_1" },
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(findToolPart(data, "call_1")).toMatchObject({
      state: "approval-responded",
      toolMetadata: {
        eve: {
          inputResponse: { optionId: "approve", requestId: "approval_1" },
        },
      },
    });
  });

  it("closes replayed input requests that resolve without a response", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createInputRequestedEvent({
        requests: [
          {
            action: {
              callId: "question_1",
              input: { prompt: "Which environment?" },
              kind: "tool-call",
              toolName: "ask_question",
            },
            allowFreeform: true,
            display: "text",
            kind: "question",
            prompt: "Which environment?",
            requestId: "question_1",
          },
          {
            action: {
              callId: "question_2",
              input: { prompt: "Which region?" },
              kind: "tool-call",
              toolName: "ask_question",
            },
            allowFreeform: true,
            display: "text",
            kind: "question",
            prompt: "Which region?",
            requestId: "question_2",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createInputResolvedEvent({
        resolutions: [
          {
            kind: "question",
            outcome: "ignored",
            requestId: "question_1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(findToolPart(data, "question_1")).toMatchObject({
      output: { status: "ignored" },
      state: "output-available",
    });
    expect(findToolPart(data, "question_2")).toMatchObject({
      state: "approval-requested",
    });
  });

  it.each(["rejected", "failed", "timed-out", "stale"] as const)(
    "keeps an approval answerable after a %s candidate",
    (outcome) => {
      const reducer = defaultMessageReducer();
      let data = reduceServerEvents(reducer, reducer.initial(), [
        createInputRequestedEvent({
          requests: [
            {
              action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "save_note" },
              display: "confirmation",
              kind: "tool-approval",
              options: [
                { id: "approve", label: "Approve" },
                { id: "cancel", label: "Cancel" },
              ],
              prompt: "Save the note?",
              requestId: "approval_1",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ]);
      data = reducer.reduce(data, {
        data: { createdAt: 1, responses: [{ optionId: "approve", requestId: "approval_1" }] },
        type: "client.input.responded",
      });
      expect(findToolPart(data, "call_1")).toMatchObject({ state: "approval-requested" });
      data = reduceServerEvents(reducer, data, [
        {
          type: "approval.candidate",
          data: {
            candidateId: "candidate_1",
            requestId: "approval_1",
            responderPrincipalId: "alice",
            outcome,
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
      ]);
      expect(findToolPart(data, "call_1")).toMatchObject({ state: "approval-requested" });
      expect(findToolPart(data, "call_1")?.toolMetadata?.eve?.inputResponse).toBeUndefined();
      data = reduceServerEvents(reducer, data, [
        {
          type: "approval.settled",
          data: {
            requestId: "approval_1",
            responderPrincipalId: "bob",
            outcome: "approved",
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
      ]);
      expect(findToolPart(data, "call_1")).toMatchObject({
        state: "approval-responded",
        approval: { approved: true },
      });
    },
  );

  it("merges resumed approval results back into the requested tool part", () => {
    const reducer = defaultMessageReducer();
    let data = reduceServerEvents(reducer, reducer.initial(), [
      createInputRequestedEvent({
        requests: [
          {
            action: {
              callId: "call_1",
              input: { command: "echo 1" },
              kind: "tool-call",
              toolName: "bash",
            },
            display: "confirmation",
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Yes", style: "primary" },
              { id: "deny", label: "No", style: "danger" },
            ],
            prompt: "Approve tool call: bash",
            requestId: "approval_1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
    ]);

    data = reducer.reduce(data, {
      data: {
        createdAt: 1,
        responses: [{ optionId: "approve", requestId: "approval_1" }],
      },
      type: "client.input.responded",
    });
    data = reduceServerEvents(reducer, data, [
      createInputResolvedEvent({
        resolutions: [
          {
            kind: "tool-approval",
            outcome: "approved",
            requestId: "approval_1",
            response: { optionId: "approve", requestId: "approval_1" },
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      createStepStartedEvent({
        modelId: "openai/gpt-5.5",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createActionResultEvent({
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: "1",
          toolName: "bash",
        },
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    const toolParts = data.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "dynamic-tool"),
    );

    expect(
      data.messages.map((message) => [message.id, message.parts.map((part) => part.type)]),
    ).toEqual([
      ["turn_0:assistant", ["step-start", "dynamic-tool"]],
      ["turn_1:assistant", ["step-start"]],
    ]);
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]).toMatchObject({
      approval: {
        approved: true,
        id: "approval_1",
      },
      input: { command: "echo 1" },
      output: "1",
      state: "output-available",
      toolCallId: "call_1",
      toolMetadata: {
        eve: {
          inputRequest: {
            prompt: "Approve tool call: bash",
            requestId: "approval_1",
          },
          inputResponse: { optionId: "approve", requestId: "approval_1" },
          kind: "tool-call",
          name: "bash",
        },
      },
      toolName: "bash",
      type: "dynamic-tool",
    });
  });

  it("keeps text from separate steps as separate parts", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createMessageCompletedEvent({
        message: "First step.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createMessageCompletedEvent({
        message: "Second step.",
        sequence: 1,
        stepIndex: 1,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages).toEqual([
      {
        id: "turn_1:assistant",
        metadata: {
          status: "complete",
          turnId: "turn_1",
        },
        parts: [
          { type: "step-start" },
          {
            state: "done",
            stepIndex: 0,
            text: "First step.",
            type: "text",
          },
          { type: "step-start" },
          {
            state: "done",
            stepIndex: 1,
            text: "Second step.",
            type: "text",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("keeps multiple text runs within a single step as separate parts", () => {
    // Regression test for https://github.com/vercel/eve/issues/436: a step can
    // legitimately produce text, call tools, then produce more text. Keying
    // text parts by stepIndex alone drops the first run and reorders the second
    // ahead of the tool call.
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createMessageAppendedEvent({
        messageDelta: "Checking Vienna",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      createMessageCompletedEvent({
        finishReason: "tool-calls",
        message: "Checking Vienna first.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      createActionsRequestedEvent({
        actions: [
          {
            callId: "call_1",
            input: { city: "Vienna" },
            kind: "tool-call",
            toolName: "get_weather",
          },
        ],
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      createMessageAppendedEvent({
        messageDelta: "Now Berlin",
        sequence: 3,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      createMessageCompletedEvent({
        message: "Now checking Berlin.",
        sequence: 4,
        stepIndex: 0,
        turnId: "turn_0",
      }),
    ]);

    const assistant = data.messages.find((message) => message.id === "turn_0:assistant");
    expect(
      assistant?.parts
        .filter((part) => part.type === "text" || part.type === "dynamic-tool")
        .map((part) => (part.type === "text" ? part.text : `tool:${part.toolCallId}`)),
    ).toEqual(["Checking Vienna first.", "tool:call_1", "Now checking Berlin."]);
  });

  it("finalizes partial streamed message and reasoning when the turn is cancelled", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createReasoningAppendedEvent({
        reasoningDelta: "Thinking",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createMessageAppendedEvent({
        messageDelta: "Partial",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createTurnCancelledEvent({ sequence: 2, turnId: "turn_1" }),
    ]);

    expect(data.messages).toEqual([
      {
        id: "turn_1:assistant",
        metadata: {
          status: "complete",
          turnId: "turn_1",
        },
        parts: [
          { type: "step-start" },
          {
            state: "done",
            stepIndex: 0,
            text: "Thinking",
            type: "reasoning",
          },
          {
            state: "done",
            stepIndex: 0,
            text: "Partial",
            type: "text",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("removes streamed text for a null message completion", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createMessageCompletedEvent({
        message: "Earlier step.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createMessageAppendedEvent({
        messageDelta: "<eve-empty-delivery/>",
        sequence: 1,
        stepIndex: 1,
        turnId: "turn_1",
      }),
      createMessageCompletedEvent({
        message: null,
        sequence: 1,
        stepIndex: 1,
        turnId: "turn_1",
      }),
    ]);

    expect(data.messages[0]?.parts).toEqual([
      { type: "step-start" },
      {
        state: "done",
        stepIndex: 0,
        text: "Earlier step.",
        type: "text",
      },
      { type: "step-start" },
    ]);
  });

  it("preserves separate participant messages received within one turn", () => {
    const reducer = defaultMessageReducer();
    const events = stampTestEvents([
      createMessageReceivedEvent({ message: "test message", sequence: 0, turnId: "turn_1" }),
      createMessageReceivedEvent({ message: "a", sequence: 1, turnId: "turn_1" }),
    ]).map((event, index) => ({
      ...event,
      meta: { ...event.meta, deliveryIds: [`delivery_${index}`] },
    }));
    const reduce = () =>
      events.reduce((data, event) => reducer.reduce(data, event), reducer.initial());

    const data = reduce();
    expect(data.messages.map((message) => message.id)).toEqual(
      events.map((event) => `${event.meta.id}:user`),
    );
    expect(data.messages.map((message) => message.parts)).toEqual([
      [{ state: "done", text: "test message", type: "text" }],
      [{ state: "done", text: "a", type: "text" }],
    ]);
    expect(reduce().messages.map((message) => message.id)).toEqual(
      data.messages.map((message) => message.id),
    );
  });

  it("projects one bubble for one coalesced participant event", () => {
    const reducer = defaultMessageReducer();
    const [event] = stampTestEvents([
      createMessageReceivedEvent({ message: "first\n\nsecond", sequence: 0, turnId: "turn_1" }),
    ]).map((candidate) => ({
      ...candidate,
      meta: { ...candidate.meta, deliveryIds: ["delivery_1", "delivery_2"] },
    }));
    const data = reducer.reduce(reducer.initial(), event!);

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]?.parts).toEqual([
      { state: "done", text: "first\n\nsecond", type: "text" },
    ]);
  });

  it("uses a stable fallback id for legacy received events", () => {
    const reducer = defaultMessageReducer();
    const event = {
      ...createMessageReceivedEvent({ message: "legacy", sequence: 2, turnId: "turn_1" }),
      meta: { at: "2026-07-27T18:04:11.912Z" },
    } as MessageStreamEvent;

    const data = reducer.reduce(reducer.initial(), event);
    expect(data.messages[0]?.id).toBe("turn_1:2:user");
  });

  it("projects structured file parts from message.received onto the user message", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      {
        data: {
          message: "describe this\n[file: report.pdf (application/pdf)]",
          parts: [
            { text: "describe this", type: "text" },
            {
              filename: "report.pdf",
              mediaType: "application/pdf",
              size: 4,
              type: "file",
              url: "https://files.example.com/report.pdf",
            },
          ],
          sequence: 1,
          turnId: "turn_1",
        },
        type: "message.received",
      },
    ]);

    const userMessage = data.messages.find((message) => message.role === "user");
    expect(userMessage?.parts).toEqual([
      { state: "done", text: "describe this", type: "text" },
      {
        filename: "report.pdf",
        mediaType: "application/pdf",
        size: 4,
        type: "file",
        url: "https://files.example.com/report.pdf",
      },
    ]);
  });

  it("falls back to a single text part when message.received omits parts", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      {
        data: { message: "hello there", sequence: 1, turnId: "turn_1" },
        type: "message.received",
      },
    ]);

    const userMessage = data.messages.find((message) => message.role === "user");
    expect(userMessage?.parts).toEqual([{ state: "done", text: "hello there", type: "text" }]);
  });

  it("does not render delivered task results as a user message", () => {
    const reducer = defaultMessageReducer();
    const data = reduceServerEvents(reducer, reducer.initial(), [
      createMessageReceivedEvent({
        message:
          '<task_result id="remind-q4x1ze" tool="remind" status="completed">\nDone\n</task_result>',
        sequence: 2,
        taskIds: ["remind-q4x1ze"],
        turnId: "turn_2",
      }),
      createMessageCompletedEvent({
        message: "Your reminder fired.",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_2",
      }),
    ]);

    expect(data.messages.map((message) => message.role)).toEqual(["assistant"]);
  });
});

function findToolPart(
  data: ReturnType<ReturnType<typeof defaultMessageReducer>["initial"]>,
  toolCallId: string,
) {
  return data.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "dynamic-tool")
    .find((part) => part.toolCallId === toolCallId);
}
