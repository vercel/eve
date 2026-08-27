import {
  isStepCount,
  simulateReadableStream,
  tool,
  ToolLoopAgent,
  type ModelMessage,
  type ToolApprovalRequest,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

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

function streamResult(chunks: StreamPart[]): StreamResult {
  return { stream: simulateReadableStream({ chunks }) };
}

function findApprovalRequest(messages: readonly ModelMessage[]): ToolApprovalRequest | undefined {
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-approval-request") {
        return part;
      }
    }
  }
  return undefined;
}

describe("AI SDK approval-resume streaming contract", () => {
  it("streams a cross-invocation result and includes it in call-wide response messages", async () => {
    const execute = vi.fn(async ({ note }: { readonly note: string }) => ({ echoed: note }));
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult([
          { type: "stream-start", warnings: [] },
          {
            input: JSON.stringify({ note: "approved" }),
            toolCallId: "call-1",
            toolName: "guardedEcho",
            type: "tool-call",
          },
          {
            finishReason: { raw: undefined, unified: "tool-calls" },
            type: "finish",
            usage,
          },
        ]),
        streamResult([
          { type: "stream-start", warnings: [] },
          { id: "answer", type: "text-start" },
          { delta: "Approved result received.", id: "answer", type: "text-delta" },
          { id: "answer", type: "text-end" },
          {
            finishReason: { raw: undefined, unified: "stop" },
            type: "finish",
            usage,
          },
        ]),
      ],
      modelId: "approval-resume-model",
      provider: "eve-integration-mock",
    });
    const agent = new ToolLoopAgent({
      model,
      stopWhen: isStepCount(1),
      toolApproval: () => "user-approval",
      tools: {
        guardedEcho: tool({
          description: "Echo an approved note.",
          execute,
          inputSchema: z.object({ note: z.string() }),
          toModelOutput: ({ output }) => ({
            type: "text",
            value: `canonical:${output.echoed}`,
          }),
        }),
      },
    });
    const initialMessages: ModelMessage[] = [
      { content: "Run guardedEcho with the approved note.", role: "user" },
    ];

    const approvalRequest = await agent.stream({ messages: initialMessages });
    const approvalStreamParts = [];
    for await (const part of approvalRequest.fullStream) {
      approvalStreamParts.push(part);
    }
    const approvalResponseMessages = await approvalRequest.responseMessages;
    const approvalPart = findApprovalRequest(approvalResponseMessages);

    expect(approvalStreamParts.map((part) => part.type)).toContain("tool-call");
    expect(approvalStreamParts.map((part) => part.type)).toContain("tool-approval-request");
    expect(approvalStreamParts.map((part) => part.type)).not.toContain("tool-result");
    expect(approvalPart).toMatchObject({ toolCallId: "call-1" });
    expect(execute).not.toHaveBeenCalled();
    if (approvalPart === undefined) {
      throw new Error("AI SDK did not produce a tool approval request.");
    }

    const resumeMessages: ModelMessage[] = [
      ...initialMessages,
      ...approvalResponseMessages,
      {
        content: [
          {
            approvalId: approvalPart.approvalId,
            approved: true,
            type: "tool-approval-response",
          },
        ],
        role: "tool",
      },
    ];
    const resumed = await agent.stream({ messages: resumeMessages });
    const resumedStreamParts = [];
    for await (const part of resumed.fullStream) {
      resumedStreamParts.push(part);
    }
    const resumedResponseMessages = await resumed.responseMessages;
    const resumedSteps = await resumed.steps;

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { note: "approved" },
      expect.objectContaining({ toolCallId: "call-1" }),
    );
    expect(
      resumedStreamParts.filter((part) => part.type === "tool-call").map((part) => part.toolCallId),
    ).toEqual([]);
    const streamedToolResult = resumedStreamParts.find((part) => part.type === "tool-result");
    expect(streamedToolResult).toMatchObject({
      output: { echoed: "approved" },
      toolCallId: "call-1",
    });
    const streamedToolResultIndex = resumedStreamParts.findIndex(
      (part) => part.type === "tool-result",
    );
    const modelStepIndex = resumedStreamParts.findIndex((part) => part.type === "start-step");
    expect(streamedToolResultIndex).toBeGreaterThanOrEqual(0);
    expect(modelStepIndex).toBeGreaterThan(streamedToolResultIndex);
    expect(resumedSteps).toHaveLength(1);
    expect(resumedSteps[0]?.response.messages.map((message) => message.role)).toEqual([
      "assistant",
    ]);
    expect(resumedResponseMessages.map((message) => message.role)).toEqual(["tool", "assistant"]);
    expect(resumedResponseMessages[0]).toEqual({
      content: [
        {
          output: { type: "text", value: "canonical:approved" },
          toolCallId: "call-1",
          toolName: "guardedEcho",
          type: "tool-result",
        },
      ],
      role: "tool",
    });

    const providerPrompt = model.doStreamCalls[1]?.prompt ?? [];
    const providerToolResults = providerPrompt.flatMap((message) =>
      message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : [],
    );
    expect(providerToolResults).toEqual([
      expect.objectContaining({ toolCallId: "call-1", toolName: "guardedEcho" }),
    ]);
  });
});
