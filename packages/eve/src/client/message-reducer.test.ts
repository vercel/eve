import { describe, expect, it } from "vitest";

import { defaultMessageReducer } from "#client/message-reducer.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createInputResponseActionResultEvent,
  createInputTerminalActionResultEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createReasoningAppendedEvent,
  createReasoningCompletedEvent,
  createResultCompletedEvent,
  createStepStartedEvent,
  createTurnCancelledEvent,
} from "#protocol/message.js";

describe("defaultMessageReducer", () => {
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
    data = reducer.reduce(
      data,
      createReasoningCompletedEvent({
        blockIndex: 0,
        reasoning: "Need the weather tool.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );
    data = reducer.reduce(
      data,
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
    );
    data = reducer.reduce(
      data,
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
    );

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
            blockIndex: 0,
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
    const data = reducer.reduce(
      reducer.initial(),
      createActionResultEvent({
        result: {
          callId: "call_1",
          kind: "subagent-result",
          output: { summary: "done" },
          subagentName: "research",
        },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );

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
    const data = reducer.reduce(
      reducer.initial(),
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
    );

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

    data = reducer.reduce(
      data,
      createResultCompletedEvent({
        result: { title: "Done" },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );

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
    const data = reducer.reduce(
      reducer.initial(),
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
    );

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
    let data = reducer.reduce(
      reducer.initial(),
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
    );

    data = reducer.reduce(
      data,
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
    );

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
    const data = reducer.reduce(
      reducer.initial(),
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
    );

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

  it("marks input requests as responded when the client submits a response", () => {
    const reducer = defaultMessageReducer();
    let data = reducer.reduce(
      reducer.initial(),
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
    );

    data = reducer.reduce(data, {
      data: {
        createdAt: 1,
        responses: [{ optionId: "deny", requestId: "approval_1" }],
      },
      type: "client.input.responded",
    });

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
            state: "approval-responded",
            stepIndex: 0,
            toolCallId: "call_1",
            toolMetadata: {
              eve: {
                inputRequest: {
                  allowFreeform: undefined,
                  display: "confirmation",
                  options: [
                    { id: "approve", label: "Yes", style: "primary" },
                    { id: "deny", label: "No", style: "danger" },
                  ],
                  prompt: "Approve tool call: bash",
                  requestId: "approval_1",
                },
                inputResponse: { optionId: "deny", requestId: "approval_1" },
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

  it("replays accepted and terminal input settlements as non-actionable", () => {
    const request = {
      action: {
        callId: "question-1",
        input: { prompt: "Choose" },
        kind: "tool-call" as const,
        toolName: "ask_question",
      },
      display: "select" as const,
      options: [{ id: "one", label: "One" }],
      prompt: "Choose",
      requestId: "request-1",
    };
    const requested = createInputRequestedEvent({
      requests: [request],
      sequence: 0,
      stepIndex: 0,
      turnId: "request-turn",
    });
    const responded = createInputResponseActionResultEvent({
      request,
      response: { optionId: "one", requestId: "request-1" },
      sequence: 0,
      stepIndex: 0,
      turnId: "request-turn",
    });
    const reducer = defaultMessageReducer();
    let respondedData = reducer.reduce(reducer.initial(), requested);
    respondedData = reducer.reduce(respondedData, responded);
    const respondedReplay = reducer.reduce(respondedData, responded);

    expect(respondedReplay).toEqual(respondedData);
    expect(
      respondedData.messages.flatMap((message) =>
        message.parts.filter((part) => part.type === "dynamic-tool"),
      ),
    ).toEqual([
      expect.objectContaining({
        output: { optionId: "one", status: "answered" },
        state: "output-available",
        toolCallId: "question-1",
        toolMetadata: expect.objectContaining({
          eve: expect.objectContaining({
            inputResponse: { optionId: "one", requestId: "request-1" },
          }),
        }),
      }),
    ]);

    for (const outcome of ["ignored", "cancelled", "failed"] as const) {
      let terminalData = reducer.reduce(reducer.initial(), requested);
      terminalData = reducer.reduce(
        terminalData,
        createInputTerminalActionResultEvent({
          outcome,
          request,
          sequence: 0,
          stepIndex: 0,
          turnId: "request-turn",
        }),
      );
      expect(
        terminalData.messages.some((message) =>
          message.parts.some(
            (part) => part.type === "dynamic-tool" && part.state === "approval-requested",
          ),
        ),
      ).toBe(false);
      expect(
        terminalData.messages.flatMap((message) =>
          message.parts.filter((part) => part.type === "dynamic-tool"),
        )[0],
      ).toMatchObject({ output: { status: outcome }, state: "output-available" });
    }
  });

  it("preserves equal completed blocks in one step across duplicate replay", () => {
    const reducer = defaultMessageReducer();
    const blocks = [
      createMessageCompletedEvent({
        blockIndex: 0,
        finishReason: "tool-calls",
        message: "Repeated narration.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      createMessageCompletedEvent({
        blockIndex: 1,
        message: "Repeated narration.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
    ];
    let data = reducer.initial();
    for (const event of [...blocks, ...blocks]) {
      data = reducer.reduce(data, event);
    }

    expect(
      data.messages.flatMap((message) =>
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => ({ blockIndex: part.blockIndex, text: part.text })),
      ),
    ).toEqual([
      { blockIndex: 0, text: "Repeated narration." },
      { blockIndex: 1, text: "Repeated narration." },
    ]);
  });

  it("merges resumed approval results back into the requested tool part", () => {
    const reducer = defaultMessageReducer();
    let data = reducer.reduce(
      reducer.initial(),
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
    );

    data = reducer.reduce(data, {
      data: {
        createdAt: 1,
        responses: [{ optionId: "approve", requestId: "approval_1" }],
      },
      type: "client.input.responded",
    });
    data = reducer.reduce(
      data,
      createStepStartedEvent({
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );
    data = reducer.reduce(
      data,
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
    );

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
    let data = reducer.initial();

    data = reducer.reduce(
      data,
      createMessageCompletedEvent({
        blockIndex: 0,
        message: "First step.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );
    data = reducer.reduce(
      data,
      createMessageCompletedEvent({
        blockIndex: 0,
        message: "Second step.",
        sequence: 1,
        stepIndex: 1,
        turnId: "turn_1",
      }),
    );

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
            blockIndex: 0,
            state: "done",
            stepIndex: 0,
            text: "First step.",
            type: "text",
          },
          { type: "step-start" },
          {
            blockIndex: 0,
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
    let data = reducer.initial();

    data = reducer.reduce(
      data,
      createMessageAppendedEvent({
        blockIndex: 0,
        messageDelta: "Checking Vienna",
        messageSoFar: "Checking Vienna",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
    );
    data = reducer.reduce(
      data,
      createMessageCompletedEvent({
        blockIndex: 0,
        finishReason: "tool-calls",
        message: "Checking Vienna first.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_0",
      }),
    );
    data = reducer.reduce(
      data,
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
    );
    data = reducer.reduce(
      data,
      createMessageAppendedEvent({
        blockIndex: 1,
        messageDelta: "Now Berlin",
        messageSoFar: "Now Berlin",
        sequence: 3,
        stepIndex: 0,
        turnId: "turn_0",
      }),
    );
    data = reducer.reduce(
      data,
      createMessageCompletedEvent({
        blockIndex: 1,
        message: "Now checking Berlin.",
        sequence: 4,
        stepIndex: 0,
        turnId: "turn_0",
      }),
    );

    const assistant = data.messages.find((message) => message.id === "turn_0:assistant");
    expect(
      assistant?.parts
        .filter((part) => part.type === "text" || part.type === "dynamic-tool")
        .map((part) => (part.type === "text" ? part.text : `tool:${part.toolCallId}`)),
    ).toEqual(["Checking Vienna first.", "tool:call_1", "Now checking Berlin."]);
  });

  it("finalizes partial streamed message and reasoning when the turn is cancelled", () => {
    const reducer = defaultMessageReducer();
    let data = reducer.reduce(
      reducer.initial(),
      createReasoningAppendedEvent({
        blockIndex: 0,
        reasoningDelta: "Thinking",
        reasoningSoFar: "Thinking",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );
    data = reducer.reduce(
      data,
      createMessageAppendedEvent({
        blockIndex: 1,
        messageDelta: "Partial",
        messageSoFar: "Partial",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );
    data = reducer.reduce(data, createTurnCancelledEvent({ sequence: 2, turnId: "turn_1" }));

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
            blockIndex: 0,
            state: "done",
            stepIndex: 0,
            text: "Thinking",
            type: "reasoning",
          },
          {
            blockIndex: 1,
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
    let data = reducer.reduce(
      reducer.initial(),
      createMessageCompletedEvent({
        blockIndex: 0,
        message: "Earlier step.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );
    data = reducer.reduce(
      data,
      createMessageAppendedEvent({
        blockIndex: 0,
        messageDelta: "<eve-empty-delivery/>",
        messageSoFar: "<eve-empty-delivery/>",
        sequence: 1,
        stepIndex: 1,
        turnId: "turn_1",
      }),
    );
    data = reducer.reduce(
      data,
      createMessageCompletedEvent({
        blockIndex: 0,
        message: null,
        sequence: 1,
        stepIndex: 1,
        turnId: "turn_1",
      }),
    );

    expect(data.messages[0]?.parts).toEqual([
      { type: "step-start" },
      {
        blockIndex: 0,
        state: "done",
        stepIndex: 0,
        text: "Earlier step.",
        type: "text",
      },
      { type: "step-start" },
    ]);
  });

  it("projects structured file parts from message.received onto the user message", () => {
    const reducer = defaultMessageReducer();
    const data = reducer.reduce(reducer.initial(), {
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
    });

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
    const data = reducer.reduce(reducer.initial(), {
      data: { message: "hello there", sequence: 1, turnId: "turn_1" },
      type: "message.received",
    });

    const userMessage = data.messages.find((message) => message.role === "user");
    expect(userMessage?.parts).toEqual([{ state: "done", text: "hello there", type: "text" }]);
  });
});
