import { describe, expect, it } from "vitest";

import { defaultMessageReducer } from "#client/message-reducer.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createReasoningCompletedEvent,
  createResultCompletedEvent,
  createStepStartedEvent,
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
        message: "First step.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );
    data = reducer.reduce(
      data,
      createMessageCompletedEvent({
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

  it("removes streamed text for a null message completion", () => {
    const reducer = defaultMessageReducer();
    let data = reducer.reduce(
      reducer.initial(),
      createMessageCompletedEvent({
        message: "Earlier step.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    );
    data = reducer.reduce(
      data,
      createMessageAppendedEvent({
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
        message: null,
        sequence: 1,
        stepIndex: 1,
        turnId: "turn_1",
      }),
    );

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
});
