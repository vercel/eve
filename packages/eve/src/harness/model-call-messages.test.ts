import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { materializeExecutionDeniedToolResultsForModel } from "#harness/model-call-messages.js";

describe("materializeExecutionDeniedToolResultsForModel", () => {
  it("rewrites an execution-denied output to error-text", () => {
    const messages: ModelMessage[] = [
      { content: "Run the risky tool.", role: "user" },
      {
        content: [
          {
            input: { url: "https://example.com" },
            toolCallId: "call-1",
            toolName: "fetch",
            type: "tool-call",
          },
          {
            approvalId: "approval-1",
            toolCallId: "call-1",
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            approvalId: "approval-1",
            approved: false,
            reason: "Policy forbids external fetches.",
            type: "tool-approval-response",
          },
          {
            output: { type: "execution-denied", reason: "Policy forbids external fetches." },
            toolCallId: "call-1",
            toolName: "fetch",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      { content: "Understood.", role: "user" },
    ];

    const result = materializeExecutionDeniedToolResultsForModel(messages);
    // The persisted message is untouched.
    const persistedToolMessage = messages[2];
    if (persistedToolMessage?.role !== "tool" || typeof persistedToolMessage.content === "string") {
      throw new Error("Expected the assistant-adjacent tool message to have array content.");
    }
    const persistedDenied = persistedToolMessage.content.find(
      (part) => part.type === "tool-result",
    );
    expect(persistedDenied).toMatchObject({
      output: { type: "execution-denied" },
    });

    // The model-bound message is rewritten to a recognized output shape.
    const toolMessage = result[2];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("Expected a tool message with array content.");
    }
    const rewritten = toolMessage.content.find((part) => part.type === "tool-result");
    expect(rewritten).toEqual({
      output: {
        type: "error-text",
        value: "Tool execution was denied: Policy forbids external fetches.",
      },
      toolCallId: "call-1",
      toolName: "fetch",
      type: "tool-result",
    });

    // The approval response part is preserved.
    expect(toolMessage.content).toContainEqual({
      approvalId: "approval-1",
      approved: false,
      reason: "Policy forbids external fetches.",
      type: "tool-approval-response",
    });

    // Non-tool messages pass through unchanged (deep equality; the helper
    // does not promise index identity).
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
    expect(result[3]).toEqual(messages[3]);
  });

  it("falls back to a default denial message when reason is empty or missing", () => {
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "execution-denied" },
            toolCallId: "call-x",
            toolName: "guarded",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const result = materializeExecutionDeniedToolResultsForModel(messages);
    const toolMessage = result[0];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("Expected a tool message with array content.");
    }
    const rewritten = toolMessage.content.find((part) => part.type === "tool-result");
    expect(rewritten).toEqual({
      output: { type: "error-text", value: "Tool execution was denied." },
      toolCallId: "call-x",
      toolName: "guarded",
      type: "tool-result",
    });
  });

  it("leaves recognized tool-result outputs untouched", () => {
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "text", value: "ok" },
            toolCallId: "call-y",
            toolName: "echo",
            type: "tool-result",
          },
          {
            output: { type: "error-text", value: "already an error" },
            toolCallId: "call-z",
            toolName: "echo",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const result = materializeExecutionDeniedToolResultsForModel(messages);
    expect(result[0]).toBe(messages[0]);
  });

  it("passes through non-tool messages by reference", () => {
    const messages: ModelMessage[] = [
      { content: "Hello.", role: "user" },
      {
        content: [{ text: "I can help with that.", type: "text" }],
        role: "assistant",
      },
    ];

    const result = materializeExecutionDeniedToolResultsForModel(messages);
    expect(result).toBe(messages);
  });

  it("handles string-content assistant messages without touching them", () => {
    const messages: ModelMessage[] = [
      { content: "plain tool payload", role: "assistant" },
      { content: "plain user payload", role: "user" },
      { content: "plain system payload", role: "system" },
    ];
    const result = materializeExecutionDeniedToolResultsForModel(messages);
    expect(result).toBe(messages);
  });

  it("rewrites multiple denied results in a single message", () => {
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "execution-denied", reason: "denied A" },
            toolCallId: "call-a",
            toolName: "toolA",
            type: "tool-result",
          },
          {
            output: { type: "text", value: "ok" },
            toolCallId: "call-b",
            toolName: "toolB",
            type: "tool-result",
          },
          {
            output: { type: "execution-denied", reason: "denied C" },
            toolCallId: "call-c",
            toolName: "toolC",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const result = materializeExecutionDeniedToolResultsForModel(messages);
    const toolMessage = result[0];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("Expected a tool message with array content.");
    }
    const denied = toolMessage.content.filter(
      (part) => part.type === "tool-result" && part.output.type === "error-text",
    );
    expect(denied).toHaveLength(2);
    expect(denied[0]).toEqual({
      output: { type: "error-text", value: "Tool execution was denied: denied A" },
      toolCallId: "call-a",
      toolName: "toolA",
      type: "tool-result",
    });
    expect(denied[1]).toEqual({
      output: { type: "error-text", value: "Tool execution was denied: denied C" },
      toolCallId: "call-c",
      toolName: "toolC",
      type: "tool-result",
    });
  });
});
