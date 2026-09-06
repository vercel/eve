import { getRequestEnvelopeTokens } from "#harness/request-envelope.js";
import { generateText, jsonSchema, type LanguageModel, ToolLoopAgent } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendPendingInputBatch } from "#harness/input-requests.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepFn, StepNext, ToolLoopHarnessConfig } from "#harness/types.js";
import {
  applyMemoryRecallBatches,
  createMemoryLock,
  projectMemoryHistoryFromSessionState,
  validateMemoryRecallResult,
} from "#shared/memory-state.js";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  ToolLoopAgent: vi.fn(),
  jsonSchema: vi.fn((schema: unknown) => schema),
  isStepCount: vi.fn((value: number) => value),
  tool: vi.fn((definition: unknown) => definition),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function createTestSession(overrides?: Partial<HarnessSession>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "You are a test assistant.",
      tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [],
    sessionId: "test-session",
    ...overrides,
  };
}

function createTestConfig(overrides?: Partial<ToolLoopHarnessConfig>): ToolLoopHarnessConfig {
  return {
    mode: "conversation",
    resolveModel: vi.fn().mockResolvedValue({} as LanguageModel),
    tools: new Map([
      [
        "add",
        {
          description: "Adds numbers",
          execute: vi.fn().mockResolvedValue("42"),
          inputSchema: jsonSchema({ type: "object" }),
          name: "add",
        },
      ],
    ]),
    ...overrides,
  };
}

type MockAgentSettings = {
  onStepFinish?: (step: unknown) => Promise<void> | void;
  prepareStep?: (input: unknown) => Promise<unknown> | unknown;
};

type MockAgentConstructor =
  ConstructorParameters<typeof ToolLoopAgent> extends [infer S]
    ? (settings: S) => ToolLoopAgent
    : never;

function getMockResponseMessages(result: Record<string, unknown>): unknown[] {
  const response = result.response;
  if (
    typeof response !== "object" ||
    response === null ||
    !("messages" in response) ||
    !Array.isArray(response.messages)
  ) {
    throw new Error("Mock ToolLoopAgent result must include response messages.");
  }
  return response.messages;
}

function setupMockAgentSequence(results: readonly Record<string, unknown>[]): void {
  const queue = [...results];

  vi.mocked(ToolLoopAgent).mockImplementation(function (
    this: Record<string, unknown>,
    settings: MockAgentSettings,
  ) {
    const { onStepFinish, prepareStep } = settings;

    const generate = vi.fn().mockImplementation(async (options: { messages: unknown[] }) => {
      const result = queue.shift();
      if (result === undefined) {
        throw new Error("No mock ToolLoopAgent result available.");
      }

      if (prepareStep) {
        await prepareStep({
          messages: options.messages,
          model: {},
          runtimeContext: {},
          stepNumber: 0,
          steps: [],
          toolsContext: {},
        });
      }

      if (onStepFinish) {
        await onStepFinish(result);
      }

      return { ...result, responseMessages: getMockResponseMessages(result) };
    });

    this.generate = generate;
    this.stream = vi.fn(async (options: { messages: unknown[] }) => {
      const result = await generate(options);
      return {
        fullStream: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        responseMessages: Promise.resolve(result.responseMessages),
      };
    });

    return this as unknown as ToolLoopAgent;
  } as unknown as MockAgentConstructor);
}

function expectStepFn(value: StepNext): StepFn {
  if (typeof value !== "function") {
    throw new Error("Expected a continuation step function.");
  }

  return value;
}

describe("tool-loop structured compaction accounting", () => {
  it("keeps private memory out of the summary while retaining its attributed record", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "ordinary summary",
    } as Awaited<ReturnType<typeof generateText>>);
    setupMockAgentSequence([
      {
        finishReason: "stop",
        response: { messages: [{ content: "Done.", role: "assistant" }] },
        text: "Done.",
        toolCalls: [],
        toolResults: [],
      },
    ]);
    const memoryLock = createMemoryLock({
      namespace: "app",
      scope: "user_1",
      slot: "profile",
      turn: { id: "turn_0", input: [], sequence: 0 },
      visibility: "scope",
    });
    const recalled = applyMemoryRecallBatches({
      batches: [
        {
          lock: memoryLock,
          messages: validateMemoryRecallResult(
            { messages: [{ content: "PRIVATE_MEMORY_SENTINEL", id: "profile" }] },
            "profile",
          ),
          operationId: "recall_1",
        },
      ],
      history: [],
      state: undefined,
    });
    const runStep = createToolLoopHarness(
      createTestConfig({
        historyProjector: projectMemoryHistoryFromSessionState,
        resolveModel: vi
          .fn()
          .mockResolvedValue({ provider: "test", modelId: "test-model" } as LanguageModel),
      }),
    );

    const result = await runStep(
      createTestSession({
        compaction: { recentWindowSize: 0, threshold: 100 },
        history: [
          ...recalled.history,
          { content: `ordinary ${"conversation ".repeat(100)}`, role: "user" },
        ],
        state: recalled.state,
      }),
      { message: "continue" },
    );

    expect(vi.mocked(generateText)).toHaveBeenCalledOnce();
    expect(vi.mocked(generateText).mock.calls[0]?.[0].prompt).not.toContain(
      "PRIVATE_MEMORY_SENTINEL",
    );
    expect(JSON.stringify(result.session.history)).toContain("PRIVATE_MEMORY_SENTINEL");
    expect(JSON.stringify(result.session.history)).toContain("eve.memory");
  });

  it("compacts before the continuation step when structured tool results were appended", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "summary",
    } as Awaited<ReturnType<typeof generateText>>);

    setupMockAgentSequence([
      {
        finishReason: "tool-calls",
        response: {
          messages: [
            {
              content: [
                {
                  input: { value: "a".repeat(400) },
                  toolCallId: "call-1",
                  toolName: "add",
                  type: "tool-call",
                },
              ],
              role: "assistant",
            },
            {
              content: [
                {
                  output: {
                    nested: {
                      value: "b".repeat(400),
                    },
                  },
                  toolCallId: "call-1",
                  toolName: "add",
                  type: "tool-result",
                },
              ],
              role: "tool",
            },
          ],
        },
        text: "",
        toolCalls: [
          {
            input: { value: "a".repeat(400) },
            toolCallId: "call-1",
            toolName: "add",
            type: "tool-call",
          },
        ],
        toolResults: [
          {
            output: {
              nested: {
                value: "b".repeat(400),
              },
            },
            toolCallId: "call-1",
            toolName: "add",
            type: "tool-result",
          },
        ],
        usage: {
          inputTokens: 100,
        },
      },
      {
        finishReason: "stop",
        response: {
          messages: [{ content: "Done.", role: "assistant" }],
        },
        text: "Done.",
        toolCalls: [],
        toolResults: [],
      },
    ]);

    const runStep = createToolLoopHarness(
      createTestConfig({
        resolveModel: vi
          .fn()
          .mockResolvedValue({ provider: "test", modelId: "test-model" } as LanguageModel),
      }),
    );

    const first = await runStep(
      createTestSession({
        compaction: {
          recentWindowSize: 10,
          threshold: 500,
        },
      }),
      { message: "Compute something" },
    );

    expect(first.next).toBe(runStep);
    expect(first.session.compaction).toMatchObject({
      lastKnownInputTokens: 100,
      lastKnownPromptMessageCount: 1,
    });

    const second = await expectStepFn(first.next)(first.session);

    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    expect(second.session.history[0]).toEqual({
      content: "Summary of our conversation so far:",
      role: "user",
    });
    expect(second.session.history[1]).toEqual({
      content: "summary",
      role: "assistant",
    });
  });

  it("counts synthesized pending-input tool responses when checking for compaction", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "summary",
    } as Awaited<ReturnType<typeof generateText>>);

    setupMockAgentSequence([
      {
        finishReason: "stop",
        response: {
          messages: [{ content: "Resolved.", role: "assistant" }],
        },
        text: "Resolved.",
        toolCalls: [],
        toolResults: [],
      },
    ]);

    const runStep = createToolLoopHarness(createTestConfig());
    const session = appendPendingInputBatch({
      requests: [
        {
          action: {
            callId: "question-call",
            input: { prompt: "Pick one." },
            kind: "tool-call",
            toolName: "ask_question",
          },
          display: "select",
          kind: "question",
          prompt: "Pick one.",
          requestId: "question-call",
        },
      ],
      responseMessages: [],
      session: createTestSession({
        compaction: {
          lastKnownInputTokens: 100,
          lastKnownPromptMessageCount: 1,
          recentWindowSize: 10,
          threshold: 101,
        },
        history: [{ content: "Previous exact prompt", role: "user" }],
      }),
    });

    const result = await runStep(session, {
      inputResponses: [
        {
          optionId: "yes",
          requestId: "question-call",
        },
      ],
    });

    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    expect(result.session.history[0]).toEqual({
      content: "Summary of our conversation so far:",
      role: "user",
    });
    expect(result.session.history[1]).toEqual({
      content: "summary",
      role: "assistant",
    });
  });

  it("keeps tool results verbatim across steps so history is append-only", async () => {
    // A large tool result that would have been a prime pruning target. With no
    // reactive pruning, it must survive verbatim across the continuation step —
    // nothing rewrites earlier messages mid-turn, keeping the prompt prefix
    // stable for the provider cache.
    const largeOutput = { value: "x".repeat(200_000) };

    setupMockAgentSequence([
      {
        finishReason: "tool-calls",
        response: {
          messages: [
            {
              content: [{ input: {}, toolCallId: "call-1", toolName: "add", type: "tool-call" }],
              role: "assistant",
            },
            {
              content: [
                { output: largeOutput, toolCallId: "call-1", toolName: "add", type: "tool-result" },
              ],
              role: "tool",
            },
          ],
        },
        text: "",
        toolCalls: [{ input: {}, toolCallId: "call-1", toolName: "add", type: "tool-call" }],
        toolResults: [
          { output: largeOutput, toolCallId: "call-1", toolName: "add", type: "tool-result" },
        ],
        usage: { inputTokens: 100 },
      },
      {
        finishReason: "stop",
        response: { messages: [{ content: "Done.", role: "assistant" }] },
        text: "Done.",
        toolCalls: [],
        toolResults: [],
      },
    ]);

    const runStep = createToolLoopHarness(createTestConfig());

    // Threshold far above the history size so compaction never fires; the only
    // thing that could shrink the large result is pruning, which is gone.
    const first = await runStep(
      createTestSession({ compaction: { recentWindowSize: 10, threshold: 100_000_000 } }),
      { message: "Read a big file" },
    );
    expect(first.next).toBe(runStep);

    const second = await expectStepFn(first.next)(first.session);
    expect(second.next).toBeNull();

    const toolResult = second.session.history.find(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        (m.content[0] as { toolCallId?: string }).toolCallId === "call-1",
    );
    expect(toolResult).toBeDefined();
    expect(
      (Array.isArray(toolResult?.content)
        ? (toolResult.content[0] as { output?: unknown })
        : undefined
      )?.output,
    ).toEqual(largeOutput);
  });
});

it("compacts history when dynamic instructions grow the request envelope", async () => {
  const { ContextContainer, contextStorage } = await import("#context/container.js");
  const { SessionDynamicInstructionsKey } = await import("#context/keys.js");
  vi.mocked(generateText).mockResolvedValue({ text: "summary" } as Awaited<
    ReturnType<typeof generateText>
  >);
  setupMockAgentSequence([
    {
      finishReason: "stop",
      response: { messages: [{ content: "Done.", role: "assistant" }] },
      text: "Done.",
      toolCalls: [],
      toolResults: [],
    },
  ]);
  const ctx = new ContextContainer();
  const dynamicInstructions = "tenant business policy ".repeat(1000);
  ctx.set(SessionDynamicInstructionsKey, {
    tenant: [{ role: "system", content: dynamicInstructions }],
  });
  const runStep = createToolLoopHarness(createTestConfig());
  await contextStorage.run(ctx, () =>
    runStep(
      createTestSession({
        compaction: {
          lastKnownInputTokens: 8000,
          lastKnownPromptMessageCount: 1,
          recentWindowSize: 0,
          threshold: 10000,
        },
        history: [{ role: "user", content: "earlier conversation ".repeat(1000) }],
      }),
      { message: "continue" },
    ),
  );
  expect(JSON.stringify(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0].instructions)).toContain(
    dynamicInstructions,
  );
  expect(generateText).toHaveBeenCalledOnce();
});

describe("final request envelope compaction", () => {
  const completed = () => ({
    finishReason: "stop",
    response: { messages: [{ content: "Done.", role: "assistant" }] },
    text: "Done.",
    toolCalls: [],
    toolResults: [],
    usage: { inputTokens: 8_000 },
  });

  it("does not double-count stable instructions on later turns", async () => {
    const { ContextContainer, contextStorage } = await import("#context/container.js");
    const { SessionDynamicInstructionsKey } = await import("#context/keys.js");
    const ctx = new ContextContainer();
    ctx.set(SessionDynamicInstructionsKey, {
      tenant: [{ role: "system", content: "tenant policy ".repeat(1_000) }],
    });
    setupMockAgentSequence([completed(), completed(), completed()]);
    vi.mocked(generateText).mockResolvedValue({ text: "summary" } as Awaited<
      ReturnType<typeof generateText>
    >);
    const runStep = createToolLoopHarness(createTestConfig());
    const first = await contextStorage.run(ctx, () =>
      runStep(
        createTestSession({
          compaction: { recentWindowSize: 0, threshold: 10_000 },
        }),
        { message: "First" },
      ),
    );
    expect(getRequestEnvelopeTokens(first.session)).toBeGreaterThan(3_000);
    const second = await contextStorage.run(ctx, () =>
      runStep(first.session, { message: "Second" }),
    );
    expect(generateText).not.toHaveBeenCalled();
    expect(getRequestEnvelopeTokens(second.session)).toBe(getRequestEnvelopeTokens(first.session));
    ctx.set(SessionDynamicInstructionsKey, {
      tenant: [{ role: "system", content: "tenant policy ".repeat(2_000) }],
    });
    await contextStorage.run(ctx, () => runStep(second.session, { message: "Third" }));
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("counts dynamic schemas resolved by step.started before calling the model", async () => {
    const { ContextContainer, contextStorage } = await import("#context/container.js");
    const { SessionDynamicToolMetadataKey } = await import("#context/keys.js");
    const ctx = new ContextContainer();
    const schemaDescription = "connector catalog field ".repeat(1_000);
    const events: string[] = [];
    setupMockAgentSequence([completed()]);
    vi.mocked(generateText).mockResolvedValue({ text: "summary" } as Awaited<
      ReturnType<typeof generateText>
    >);
    const runStep = createToolLoopHarness(
      createTestConfig({
        resolveModel: vi
          .fn()
          .mockResolvedValue({ provider: "test", modelId: "test-model" } as LanguageModel),
        handleEvent: async (event) => {
          events.push(event.type);
          if (event.type === "step.started")
            ctx.set(SessionDynamicToolMetadataKey, [
              {
                name: "catalog",
                resolverSlug: "connector",
                entryKey: "catalog",
                description: "Connector catalog",
                inputSchema: { type: "object", description: schemaDescription },
                callbacks: { execute: { closure: {} } },
              },
            ]);
        },
      }),
    );
    await contextStorage.run(ctx, () =>
      runStep(
        createTestSession({
          compaction: {
            lastKnownInputTokens: 8_000,
            lastKnownPromptMessageCount: 1,
            recentWindowSize: 0,
            threshold: 10_000,
          },
          history: [{ role: "user", content: "earlier" }],
        }),
        { message: "continue" },
      ),
    );
    expect(generateText).toHaveBeenCalledOnce();
    expect(events.indexOf("compaction.requested")).toBeGreaterThan(events.indexOf("step.started"));
    expect(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0].tools).toHaveProperty("catalog");
  });

  it("does not count a capability-filtered tool that the provider never sees", async () => {
    setupMockAgentSequence([completed()]);
    const runStep = createToolLoopHarness(
      createTestConfig({
        tools: new Map([
          [
            "hidden",
            {
              name: "hidden",
              description: "private catalog ".repeat(10_000),
              inputSchema: jsonSchema({ type: "object" }),
              behavior: { availability: ["requires-request-input"] },
            },
          ],
        ]),
      }),
    );
    await runStep(
      createTestSession({
        compaction: {
          lastKnownInputTokens: 8_000,
          lastKnownPromptMessageCount: 1,
          recentWindowSize: 0,
          threshold: 10_000,
        },
        history: [{ role: "user", content: "earlier" }],
      }),
      { message: "continue" },
    );
    expect(generateText).not.toHaveBeenCalled();
    expect(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0].tools).not.toHaveProperty("hidden");
  });
  it("propagates a compaction callback failure without treating it as a model failure", async () => {
    const error = new Error("memory recall failed");
    const onCompaction = vi.fn(() => {
      throw error;
    });
    vi.mocked(generateText).mockResolvedValue({ text: "summary" } as Awaited<
      ReturnType<typeof generateText>
    >);
    const runStep = createToolLoopHarness(createTestConfig({ onCompaction }));
    await expect(
      runStep(
        createTestSession({
          compaction: { recentWindowSize: 0, threshold: 100 },
          history: [{ role: "user", content: "history ".repeat(1_000) }],
        }),
        { message: "continue" },
      ),
    ).rejects.toBe(error);
    expect(onCompaction).toHaveBeenCalledOnce();
    expect(ToolLoopAgent).not.toHaveBeenCalled();
  });
});
