import { type ModelMessage, modelMessageSchema } from "ai";
import { describe, expect, it } from "vitest";

import { pruneToolResults } from "#harness/tool-result-pruning.js";

const PRUNED_PLACEHOLDER_OUTPUT = {
  type: "text",
  value: "[Tool result pruned to save context. Call the tool again if needed.]",
} as const;

/**
 * Creates a tool-result message with a text payload of `charCount` characters.
 * At 4 chars per token + structured overhead, this gives predictable token
 * estimates for testing threshold behavior.
 */
function makeToolResultMessage(
  toolName: string,
  charCount: number,
  callId = "call-1",
): ModelMessage {
  return {
    content: [
      {
        output: { type: "text", value: "x".repeat(charCount) },
        toolCallId: callId,
        toolName,
        type: "tool-result" as const,
      },
    ],
    role: "tool" as const,
  } as ModelMessage;
}

function makeAssistantMessage(text: string): ModelMessage {
  return { content: text, role: "assistant" };
}

function makeUserMessage(text: string): ModelMessage {
  return { content: text, role: "user" };
}

describe("pruneToolResults", () => {
  it("returns messages unchanged when there are no tool results", () => {
    const messages: ModelMessage[] = [makeUserMessage("Hello"), makeAssistantMessage("Hi there")];

    const result = pruneToolResults(messages);
    expect(result).toEqual(messages);
  });

  it("returns messages unchanged when tool results are small", () => {
    const messages: ModelMessage[] = [
      makeUserMessage("Read file A"),
      makeAssistantMessage("I'll read that."),
      makeToolResultMessage("read_file", 100),
    ];

    const result = pruneToolResults(messages);
    expect(result).toEqual(messages);
  });

  it("returns messages unchanged when total tool result tokens are below the minimum savings threshold", () => {
    // ~30K chars = ~15K tokens (below the 20K min savings threshold)
    const messages: ModelMessage[] = [
      makeUserMessage("Read files"),
      makeToolResultMessage("read_file", 30_000, "call-old"),
      makeAssistantMessage("Got it."),
      makeToolResultMessage("read_file", 30_000, "call-new"),
    ];

    const result = pruneToolResults(messages);
    // Even though the first result is outside the protection window,
    // total reclaimable tokens are below the minimum savings threshold.
    expect(result).toEqual(messages);
  });

  it("prunes old tool results beyond the protection window", () => {
    // Build a history with many large tool results.
    // Each result is ~200K chars = ~100K structured tokens.
    // Protection window is 40K tokens, min savings is 20K.
    const messages: ModelMessage[] = [
      makeUserMessage("Read many files"),
      // Old results (should be pruned)
      makeToolResultMessage("read_file", 200_000, "call-1"),
      makeAssistantMessage("Got file 1"),
      makeToolResultMessage("read_file", 200_000, "call-2"),
      makeAssistantMessage("Got file 2"),
      // Recent result (should be protected)
      makeToolResultMessage("read_file", 200_000, "call-3"),
    ];

    const result = pruneToolResults(messages);

    // The most recent tool result should be preserved
    const lastToolMsg = result.find(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        (m.content[0] as { toolCallId?: string }).toolCallId === "call-3",
    );
    expect(lastToolMsg).toBeDefined();
    const lastPart = Array.isArray(lastToolMsg?.content)
      ? (lastToolMsg.content[0] as { output?: unknown })
      : undefined;
    expect(lastPart?.output).toMatchObject({ value: expect.any(String) });
    expect((lastPart!.output as { value: string }).value.length).toBe(200_000);

    // Older tool results should be pruned
    const oldToolMsg = result.find(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        (m.content[0] as { toolCallId?: string }).toolCallId === "call-1",
    );
    expect(oldToolMsg).toBeDefined();
    const oldPart = Array.isArray(oldToolMsg?.content)
      ? (oldToolMsg.content[0] as { output?: unknown })
      : undefined;
    expect(oldPart?.output).toEqual(PRUNED_PLACEHOLDER_OUTPUT);
  });

  it("does not overcount tokens when a tool message has multiple parallel results", () => {
    const multiPartToolMessage: ModelMessage = {
      content: [
        {
          output: { type: "text", value: "a".repeat(50_000) },
          toolCallId: "call-a",
          toolName: "read_file",
          type: "tool-result" as const,
        },
        {
          output: { type: "text", value: "b".repeat(50_000) },
          toolCallId: "call-b",
          toolName: "read_file",
          type: "tool-result" as const,
        },
        {
          output: { type: "text", value: "c".repeat(50_000) },
          toolCallId: "call-c",
          toolName: "read_file",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    } as ModelMessage;

    const messages: ModelMessage[] = [
      makeUserMessage("Read files"),
      makeToolResultMessage("read_file", 400_000, "call-old"),
      makeAssistantMessage("Got old file"),
      multiPartToolMessage,
      makeAssistantMessage("Got three files"),
      makeToolResultMessage("read_file", 40_000, "call-recent"),
    ];

    const result = pruneToolResults(messages);

    const multiPartMsg = result.find(
      (m) => m.role === "tool" && Array.isArray(m.content) && m.content.length === 3,
    );
    expect(multiPartMsg).toBeDefined();
    const prunedPartsCount = (
      Array.isArray(multiPartMsg?.content) ? multiPartMsg.content : []
    ).filter(
      (part) =>
        JSON.stringify((part as { output?: unknown }).output) ===
        JSON.stringify(PRUNED_PLACEHOLDER_OUTPUT),
    ).length;

    // Either all multi-part entries are treated the same (all protected or
    // all pruned). The bug would cause only the newest part to be protected.
    expect(prunedPartsCount).not.toBe(2);

    const parts = Array.isArray(multiPartMsg?.content) ? multiPartMsg.content : [];
    for (const part of parts) {
      const typedPart = part as { output?: unknown };
      expect(typedPart.output).toMatchObject({ value: expect.any(String) });
      expect(typedPart.output).not.toEqual(PRUNED_PLACEHOLDER_OUTPUT);
    }

    // The old result should be pruned.
    const oldMsg = result.find(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        (m.content[0] as { toolCallId?: string }).toolCallId === "call-old",
    );
    expect(oldMsg).toBeDefined();
    const oldPart = Array.isArray(oldMsg?.content)
      ? (oldMsg.content[0] as { output?: unknown })
      : undefined;
    expect(oldPart?.output).toEqual(PRUNED_PLACEHOLDER_OUTPUT);
  });

  it("accounts for mixed-size parallel results individually", () => {
    const mixedMultiPartMessage: ModelMessage = {
      content: [
        {
          output: { type: "text", value: "huge".repeat(50_000) },
          toolCallId: "call-big",
          toolName: "read_file",
          type: "tool-result" as const,
        },
        {
          output: { type: "text", value: "tiny" },
          toolCallId: "call-small-1",
          toolName: "grep",
          type: "tool-result" as const,
        },
        {
          output: { type: "text", value: "tiny" },
          toolCallId: "call-small-2",
          toolName: "grep",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    } as ModelMessage;

    const messages: ModelMessage[] = [
      makeUserMessage("Explore codebase"),
      makeToolResultMessage("read_file", 200_000, "call-old"),
      makeAssistantMessage("Found something"),
      mixedMultiPartMessage,
      makeAssistantMessage("Processed"),
      makeToolResultMessage("read_file", 10_000, "call-recent"),
    ];

    const result = pruneToolResults(messages);

    const multiPartMsg = result.find(
      (m) => m.role === "tool" && Array.isArray(m.content) && m.content.length === 3,
    );
    expect(multiPartMsg).toBeDefined();

    const parts = Array.isArray(multiPartMsg?.content) ? multiPartMsg.content : [];
    for (const part of parts) {
      const typed = part as { output?: unknown };
      expect(typed.output).not.toEqual(PRUNED_PLACEHOLDER_OUTPUT);
    }

    // The old result should be pruned
    const oldMsg = result.find(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        (m.content[0] as { toolCallId?: string }).toolCallId === "call-old",
    );
    const oldPart = Array.isArray(oldMsg?.content)
      ? (oldMsg.content[0] as { output?: unknown })
      : undefined;
    expect(oldPart?.output).toEqual(PRUNED_PLACEHOLDER_OUTPUT);
  });

  it("uses the default placeholder for all pruned tool results", () => {
    const messages: ModelMessage[] = [
      makeUserMessage("Read many files"),
      makeToolResultMessage("read_file", 200_000, "call-1"),
      makeAssistantMessage("Got file 1"),
      makeToolResultMessage("read_file", 200_000, "call-2"),
      makeAssistantMessage("Got file 2"),
      makeToolResultMessage("read_file", 200_000, "call-3"),
    ];

    const result = pruneToolResults(messages);

    const oldMsg = result.find(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        (m.content[0] as { toolCallId?: string }).toolCallId === "call-1",
    );
    const oldPart = Array.isArray(oldMsg?.content)
      ? (oldMsg.content[0] as { output?: unknown })
      : undefined;
    expect(oldPart?.output).toEqual(PRUNED_PLACEHOLDER_OUTPUT);
  });

  it("does not modify non-tool messages", () => {
    const messages: ModelMessage[] = [
      makeUserMessage("Read many files"),
      makeToolResultMessage("read_file", 200_000, "call-1"),
      makeAssistantMessage("Got file 1"),
      makeToolResultMessage("read_file", 200_000, "call-2"),
      makeAssistantMessage("Got file 2"),
      makeToolResultMessage("read_file", 200_000, "call-3"),
    ];

    const result = pruneToolResults(messages);
    const userMessages = result.filter((m) => m.role === "user");
    const assistantMessages = result.filter((m) => m.role === "assistant");

    expect(userMessages).toHaveLength(1);
    expect(assistantMessages).toHaveLength(2);
    expect(userMessages[0]).toEqual(makeUserMessage("Read many files"));
  });

  it("keeps pruned history compatible with the AI SDK ModelMessage schema", () => {
    const messages: ModelMessage[] = [
      makeUserMessage("Read many files"),
      makeToolResultMessage("read_file", 200_000, "call-1"),
      makeAssistantMessage("Got file 1"),
      makeToolResultMessage("read_file", 200_000, "call-2"),
      makeAssistantMessage("Got file 2"),
      makeToolResultMessage("read_file", 200_000, "call-3"),
    ];

    const result = pruneToolResults(messages);

    expect(modelMessageSchema.array().safeParse(result).success).toBe(true);
  });
});
