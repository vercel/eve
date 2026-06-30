import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { describe, expect, it, vi } from "vitest";

import { createCodexSubscriptionModelWithSessionFactory } from "#internal/model-auth/codex/model.js";
import type {
  CodexAppServerListener,
  CodexAppServerSession,
} from "#internal/model-auth/codex/types.js";

describe("Codex model", () => {
  it("forwards function tools and streams Codex text", async () => {
    const session = new FakeCodexSession();
    const model = createModel(session);

    const result = await model.doStream({
      prompt: [{ content: [{ text: "What is the weather?", type: "text" }], role: "user" }],
      responseFormat: {
        schema: {
          properties: { answer: { type: "string" } },
          required: ["answer"],
          type: "object",
        },
        type: "json",
      },
      tools: [
        {
          description: "Get the weather.",
          inputSchema: {
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          },
          name: "weather",
          type: "function",
        },
      ],
    });
    await vi.waitFor(() => expect(session.input).toBeDefined());

    session.listener!.onTextDelta({ delta: "Sunny", id: "message-1" });
    session.listener!.onUsage({
      cachedInputTokens: 4,
      inputTokens: 12,
      outputTokens: 8,
      reasoningOutputTokens: 3,
    });
    session.listener!.onCompleted({ status: "completed" });

    expect(await readStream(result.stream)).toEqual([
      { type: "stream-start", warnings: [] },
      { id: "message-1", type: "text-start" },
      { delta: "Sunny", id: "message-1", type: "text-delta" },
      { id: "message-1", type: "text-end" },
      {
        finishReason: { raw: "completed", unified: "stop" },
        type: "finish",
        usage: {
          inputTokens: { cacheRead: 4, cacheWrite: undefined, noCache: 8, total: 12 },
          outputTokens: { reasoning: 3, text: 5, total: 8 },
        },
      },
    ]);
    expect(session.input).toMatchObject({
      input: [
        {
          text: expect.stringContaining("[user]\nWhat is the weather?"),
          type: "text",
        },
      ],
      model: "gpt-5.2-codex",
      outputSchema: {
        properties: { answer: { type: "string" } },
        required: ["answer"],
        type: "object",
      },
      tools: [
        {
          description: "Get the weather.",
          inputSchema: {
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          },
          name: "weather",
        },
      ],
    });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("returns a normal AI SDK tool call and closes the Codex turn", async () => {
    const session = new FakeCodexSession();
    const model = createModel(session);
    const result = await model.doStream({
      prompt: [{ content: [{ text: "Find Boston weather.", type: "text" }], role: "user" }],
      tools: [
        {
          inputSchema: { type: "object" },
          name: "weather",
          type: "function",
        },
      ],
    });
    await vi.waitFor(() => expect(session.listener).toBeDefined());

    session.listener!.onToolCall({
      arguments: { city: "Boston" },
      callId: "call-1",
      namespace: null,
      requestId: 1,
      tool: "weather",
    });

    const parts = await readStream(result.stream);
    expect(parts).toContainEqual({
      input: '{"city":"Boston"}',
      toolCallId: "call-1",
      toolName: "weather",
      type: "tool-call",
    });
    expect(parts.at(-1)).toEqual({
      finishReason: { raw: "dynamic-tool-call", unified: "tool-calls" },
      type: "finish",
      usage: {
        inputTokens: {
          cacheRead: undefined,
          cacheWrite: undefined,
          noCache: undefined,
          total: undefined,
        },
        outputTokens: {
          reasoning: undefined,
          text: undefined,
          total: undefined,
        },
      },
    });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("replays completed eve tool results into the next Codex step", async () => {
    const first = new FakeCodexSession();
    const second = new FakeCodexSession();
    const sessions = [first, second];
    const model = createCodexSubscriptionModelWithSessionFactory({ model: "gpt-5.2-codex" }, () => {
      const session = sessions.shift();
      if (session === undefined) throw new Error("No fake Codex session available.");
      return session;
    });

    const initial = await model.doStream({
      prompt: [{ content: [{ text: "Find Boston weather.", type: "text" }], role: "user" }],
      tools: [{ inputSchema: { type: "object" }, name: "weather", type: "function" }],
    });
    await vi.waitFor(() => expect(first.listener).toBeDefined());
    first.listener!.onToolCall({
      arguments: { city: "Boston" },
      callId: "call-1",
      namespace: null,
      requestId: 1,
      tool: "weather",
    });
    await readStream(initial.stream);

    const continuation = await model.doStream({
      prompt: [
        { content: [{ text: "Find Boston weather.", type: "text" }], role: "user" },
        {
          content: [
            {
              input: { city: "Boston" },
              toolCallId: "call-1",
              toolName: "weather",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              output: { type: "text", value: "72 F and sunny" },
              toolCallId: "call-1",
              toolName: "weather",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      tools: [{ inputSchema: { type: "object" }, name: "weather", type: "function" }],
    });
    await vi.waitFor(() => expect(second.input).toBeDefined());

    expect(second.input?.input[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("Tool result weather (call-1): 72 F and sunny"),
      }),
    );
    second.listener!.onCompleted({ status: "completed" });
    await readStream(continuation.stream);
  });

  it("lets AI SDK execute the eve tool instead of marking it provider-executed", async () => {
    const session = new FakeCodexSession();
    session.onStart = (listener) => {
      listener.onToolCall({
        arguments: { city: "Boston" },
        callId: "call-1",
        namespace: null,
        requestId: 1,
        tool: "weather",
      });
    };
    const execute = vi.fn(async () => "72 F");
    const model = createModel(session);

    const result = await generateText({
      model,
      prompt: "What is the weather in Boston?",
      stopWhen: stepCountIs(1),
      tools: {
        weather: tool({
          execute,
          inputSchema: jsonSchema({
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          }),
        }),
      },
    });

    expect(execute).toHaveBeenCalledWith({ city: "Boston" }, expect.anything());
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        input: { city: "Boston" },
        toolCallId: "call-1",
        toolName: "weather",
      }),
    ]);
  });

  it("leaves eve approval in control before a tool executes", async () => {
    const session = new FakeCodexSession();
    session.onStart = (listener) => {
      listener.onToolCall({
        arguments: { city: "Boston" },
        callId: "call-1",
        namespace: null,
        requestId: 1,
        tool: "weather",
      });
    };
    const execute = vi.fn(async () => "72 F");

    const result = await generateText({
      model: createModel(session),
      prompt: "What is the weather in Boston?",
      stopWhen: stepCountIs(1),
      toolApproval: () => "user-approval",
      tools: {
        weather: tool({
          execute,
          inputSchema: jsonSchema({
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          }),
        }),
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.content).toContainEqual(
      expect.objectContaining({
        toolCall: expect.objectContaining({
          toolCallId: "call-1",
          toolName: "weather",
        }),
        type: "tool-approval-request",
      }),
    );
  });
});

class FakeCodexSession implements CodexAppServerSession {
  dispose = vi.fn();
  input: Parameters<CodexAppServerSession["start"]>[0] | undefined;
  listener: CodexAppServerListener | undefined;
  onStart: ((listener: CodexAppServerListener) => void) | undefined;

  async start(input: Parameters<CodexAppServerSession["start"]>[0]): Promise<void> {
    this.input = input;
    this.listener = input.listener;
    this.onStart?.(input.listener);
  }
}

function createModel(session: FakeCodexSession) {
  return createCodexSubscriptionModelWithSessionFactory({ model: "gpt-5.2-codex" }, () => session);
}

async function readStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const values: T[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return values;
    values.push(next.value);
  }
}
