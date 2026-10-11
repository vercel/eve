import { describe, expect, it } from "vitest";

import { createRuntimeToolCallActionFromToolCall } from "#harness/tool-call-action.js";

describe("createRuntimeToolCallActionFromToolCall", () => {
  it("creates a tool-call action from a typed tool call", () => {
    const result = createRuntimeToolCallActionFromToolCall({
      toolCall: {
        toolCallId: "call-123",
        toolName: "bash",
        input: { command: "ls -la" },
        type: "tool-call",
      } as never,
    });

    expect(result).toEqual({
      callId: "call-123",
      input: { command: "ls -la" },
      kind: "tool-call",
      toolName: "bash",
    });
  });

  it("defaults to empty object when input is undefined", () => {
    const result = createRuntimeToolCallActionFromToolCall({
      toolCall: {
        toolCallId: "call-456",
        toolName: "read_file",
        input: undefined,
        type: "tool-call",
      } as never,
    });

    expect(result.input).toEqual({});
  });

  it("omits undefined properties from tool call input objects", () => {
    const result = createRuntimeToolCallActionFromToolCall({
      toolCall: {
        toolCallId: "call-789",
        toolName: "read_file",
        input: {
          path: "/workspace/foo.txt",
          startLine: undefined,
        },
        type: "tool-call",
      } as never,
    });

    expect(result.input).toEqual({
      path: "/workspace/foo.txt",
    });
  });

  it("includes the tool name when tool call input is not a JSON object", () => {
    expect(() =>
      createRuntimeToolCallActionFromToolCall({
        toolCall: {
          toolCallId: "call-123",
          toolName: "bash",
          input: [],
          type: "tool-call",
        } as never,
      }),
    ).toThrow(
      'Failed to parse tool-call arguments for "bash" (call-123): Expected a JSON-serializable object.',
    );
  });
});
