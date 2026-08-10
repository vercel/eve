import { jsonSchema, type LanguageModel, type ModelMessage, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { appendPendingInputBatch } from "#harness/input-requests.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1,
  },
  outputTokens: {
    reasoning: undefined,
    text: 1,
    total: 1,
  },
};

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

function textStreamResult(text: string): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { id: "answer", type: "text-start" },
        { delta: text, id: "answer", type: "text-delta" },
        { id: "answer", type: "text-end" },
        {
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage,
        },
      ] satisfies StreamPart[],
    }),
  };
}

const toolCall = {
  input: { command: "pwd" },
  toolCallId: "call-1",
  toolName: "bash",
  type: "tool-call" as const,
};

const approvalRequest = {
  approvalId: "approval-1",
  toolCallId: toolCall.toolCallId,
  type: "tool-approval-request" as const,
};

const secondToolCall = {
  input: { command: "whoami" },
  toolCallId: "call-2",
  toolName: "bash",
  type: "tool-call" as const,
};

const secondApprovalRequest = {
  approvalId: "approval-2",
  toolCallId: secondToolCall.toolCallId,
  type: "tool-approval-request" as const,
};

function createPendingApprovalSession(history?: readonly ModelMessage[]): HarnessSession {
  const session: HarnessSession = {
    agent: {
      modelReference: { id: "generate-approval-resume-model" },
      system: "You are a test assistant.",
      tools: [
        {
          description: "Run a shell command.",
          inputSchema: { type: "object" },
          name: toolCall.toolName,
        },
      ],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:generate-approval-resume-session",
    history: [...(history ?? [{ content: "Run pwd.", role: "user" }])],
    sessionId: "generate-approval-resume-session",
  };

  return appendPendingInputBatch({
    requests: [
      {
        action: {
          callId: toolCall.toolCallId,
          input: toolCall.input,
          kind: "tool-call",
          toolName: toolCall.toolName,
        },
        allowFreeform: false,
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes" },
          { id: "cancel", label: "No" },
        ],
        prompt: "Approve tool call: bash",
        requestId: approvalRequest.approvalId,
      },
    ],
    responseMessages: [
      {
        content: [toolCall, approvalRequest],
        role: "assistant",
      },
    ],
    session,
  });
}

function createTwoPendingApprovalSession(): HarnessSession {
  return appendPendingInputBatch({
    requests: [
      {
        action: {
          callId: secondToolCall.toolCallId,
          input: secondToolCall.input,
          kind: "tool-call",
          toolName: secondToolCall.toolName,
        },
        allowFreeform: false,
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
        prompt: "Approve tool call: bash",
        requestId: secondApprovalRequest.approvalId,
      },
    ],
    responseMessages: [
      {
        content: [secondToolCall, secondApprovalRequest],
        role: "assistant",
      },
    ],
    session: createPendingApprovalSession(),
  });
}

function createModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ text: "The command returned /workspace.", type: "text" }],
      finishReason: { raw: undefined, unified: "stop" },
      usage,
      warnings: [],
    },
    modelId: "generate-approval-resume-model",
    provider: "eve-integration-mock",
  });
}

function createConfig(
  model: MockLanguageModelV4,
  execute: (input: unknown, options: unknown) => Promise<string>,
): ToolLoopHarnessConfig {
  const tools: ToolLoopHarnessConfig["tools"] = new Map([
    [
      toolCall.toolName,
      {
        description: "Run a shell command.",
        execute,
        inputSchema: jsonSchema({ type: "object" }),
        name: toolCall.toolName,
        toModelOutput: (output) => {
          if (typeof output !== "string") {
            throw new TypeError("Expected the bash test tool to return a string.");
          }
          return { type: "text", value: `canonical:${output}` };
        },
      },
    ],
  ]);
  return {
    mode: "conversation",
    resolveModel: async (): Promise<LanguageModel> => model,
    tools,
  };
}

function findPart(
  messages: readonly ModelMessage[],
  type: "tool-approval-response" | "tool-call" | "tool-result",
): unknown {
  for (const message of messages) {
    if (
      (message.role !== "assistant" && message.role !== "tool") ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const part = message.content.find((candidate) => candidate.type === type);
    if (part !== undefined) return part;
  }
  return undefined;
}

describe("tool loop generate approval resume (real AI SDK)", () => {
  it("executes two approvals delivered together exactly once each", async () => {
    const execute = vi.fn(async (input: unknown) =>
      (input as { command: string }).command === "pwd" ? "/workspace" : "eve",
    );
    const model = createModel();

    const first = await createToolLoopHarness(createConfig(model, execute))(
      createTwoPendingApprovalSession(),
      {
        inputResponses: [
          { optionId: "approve", requestId: approvalRequest.approvalId },
          { optionId: "approve", requestId: secondApprovalRequest.approvalId },
        ],
      },
    );
    if (typeof first.next !== "function") {
      throw new TypeError("Expected the deferred approval to schedule another harness step.");
    }
    const result = await first.next(first.session);

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      secondToolCall.input,
      expect.objectContaining({ toolCallId: secondToolCall.toolCallId }),
    );

    const toolResultCallIds = result.session.history.flatMap((message) =>
      message.role === "tool" && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
        : [],
    );
    expect(toolResultCallIds).toEqual([toolCall.toolCallId, secondToolCall.toolCallId]);
  });

  it("executes an approval before replaying its message after a limit continuation", async () => {
    const execute = vi.fn(async () => "/workspace");
    const model = new MockLanguageModelV4({
      doStream: [textStreamResult("The command completed."), textStreamResult("Summary complete.")],
      modelId: "generate-approval-resume-model",
      provider: "eve-integration-mock",
    });
    const config = {
      ...createConfig(model, execute),
      handleEvent: async () => {},
    } satisfies ToolLoopHarnessConfig;
    const usageState = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 12,
      outputTokens: 3,
      sawCost: false,
    };
    const session = setTurnUsageState(
      {
        ...createPendingApprovalSession(),
        limits: { maxInputTokensPerSession: 12 },
      },
      { ...usageState, session: usageState, turnId: "turn_previous" },
    );
    const runStep = createToolLoopHarness(config);

    const limited = await runStep(session, {
      inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
      message: "Then summarize it.",
    });

    expect(execute).not.toHaveBeenCalled();
    const resumed = await runStep(limited.session, {
      inputResponses: [
        {
          optionId: "continue",
          requestId: `${session.sessionId}:limit:input:12`,
        },
      ],
    });

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );
    expect(typeof resumed.next).toBe("function");
    if (typeof resumed.next !== "function") {
      throw new TypeError("Expected the deferred message to run after approval execution.");
    }
    await resumed.next(resumed.session);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0]?.prompt.at(-1)?.role).toBe("tool");
    expect(model.doStreamCalls[1]?.prompt.at(-1)).toMatchObject({
      content: [{ text: "Then summarize it.", type: "text" }],
      role: "user",
    });
  });

  it("persists the approved pre-model tool result without an event handler", async () => {
    const execute = vi.fn(async () => "/workspace");
    const model = createModel();

    const result = await createToolLoopHarness(createConfig(model, execute))(
      createPendingApprovalSession(),
      {
        inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
      },
    );

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );

    const providerPrompt = model.doGenerateCalls[0]?.prompt ?? [];
    expect(findPart(providerPrompt, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });

    expect(result.session.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(findPart(result.session.history, "tool-call")).toEqual(toolCall);
    expect(findPart(result.session.history, "tool-approval-response")).toMatchObject({
      approvalId: approvalRequest.approvalId,
      approved: true,
    });
    expect(findPart(result.session.history, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: "The command returned /workspace.", type: "text" }],
      role: "assistant",
    });
  });

  // Acceptance gate for the HITL non-blocking plan (research/hitl-request-lifecycle.md):
  // once messages run as normal turns while an approval is open, the approval batch is
  // restored *after* that intervening exchange. This proves the AI SDK accepts the
  // late-spliced transcript shape before any behavior change lands.
  it("splices the approved batch after an intervening conversation turn", async () => {
    const interveningHistory: readonly ModelMessage[] = [
      { content: "Run pwd.", role: "user" },
      { content: "Any update on that command?", role: "user" },
      {
        content: [{ text: "Still waiting for approval to run pwd.", type: "text" }],
        role: "assistant",
      },
    ];
    const execute = vi.fn(async () => "/workspace");
    const model = createModel();

    const result = await createToolLoopHarness(createConfig(model, execute))(
      createPendingApprovalSession(interveningHistory),
      {
        inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
      },
    );

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );

    // The provider prompt keeps the intervening turn before the restored batch.
    const providerPrompt = model.doGenerateCalls[0]?.prompt ?? [];
    const interveningIndex = providerPrompt.findIndex(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("Any update"),
    );
    const toolCallIndex = providerPrompt.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "tool-call"),
    );
    expect(interveningIndex).toBeGreaterThanOrEqual(0);
    expect(toolCallIndex).toBeGreaterThan(interveningIndex);
    expect(findPart(providerPrompt, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });

    // Committed history: intervening exchange first, then the restored batch, exactly once.
    expect(result.session.history.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(findPart(result.session.history, "tool-call")).toEqual(toolCall);
    expect(findPart(result.session.history, "tool-approval-response")).toMatchObject({
      approvalId: approvalRequest.approvalId,
      approved: true,
    });
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: "The command returned /workspace.", type: "text" }],
      role: "assistant",
    });
  });
});
