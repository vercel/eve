import { generateText, jsonSchema, tool, type ToolApprovalStatus, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { extractToolApprovalInputRequests } from "#harness/input-extraction.js";

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

async function generateToolCall(status: ToolApprovalStatus): Promise<{
  readonly execute: ReturnType<typeof vi.fn>;
  readonly step: Awaited<ReturnType<typeof generateText<ToolSet>>>["steps"][number];
}> {
  const execute = vi.fn(async () => ({ ok: true }));
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          input: JSON.stringify({ command: "rm -rf /tmp/demo" }),
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-call",
        },
      ],
      finishReason: { raw: undefined, unified: "tool-calls" },
      usage,
      warnings: [],
    },
  });

  const result = await generateText({
    model,
    prompt: "Delete the temp directory.",
    toolApproval: () => status,
    tools: {
      bash: tool({
        description: "Run shell commands.",
        execute,
        inputSchema: jsonSchema({ type: "object" }),
      }),
    },
  });

  return { execute, step: result.steps[0]! };
}

describe("AI SDK 7 automatic approval extraction", () => {
  it("keeps automatic approval records out of the human input queue", async () => {
    const { execute, step } = await generateToolCall("approved");

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { command: "rm -rf /tmp/demo" },
      expect.any(Object),
    );
    expect(step.content).toContainEqual(
      expect.objectContaining({ isAutomatic: true, type: "tool-approval-request" }),
    );
    expect(extractToolApprovalInputRequests({ content: step.content })).toEqual([]);
  });

  it("keeps automatic denial records out of the human input queue", async () => {
    const { execute, step } = await generateToolCall({
      reason: "Blocked by policy.",
      type: "denied",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(step.content).toContainEqual(
      expect.objectContaining({
        approved: false,
        reason: "Blocked by policy.",
        type: "tool-approval-response",
      }),
    );
    expect(extractToolApprovalInputRequests({ content: step.content })).toEqual([]);
  });

  it("continues to queue unresolved user approval requests", async () => {
    const { execute, step } = await generateToolCall("user-approval");

    expect(execute).not.toHaveBeenCalled();
    expect(extractToolApprovalInputRequests({ content: step.content })).toEqual([
      expect.objectContaining({
        action: expect.objectContaining({ callId: "call-1", toolName: "bash" }),
        requestId: expect.any(String),
      }),
    ]);
  });
});
