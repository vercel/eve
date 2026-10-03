import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { withoutCalls } from "#harness/human-input/suspended-step.js";

const signInCall = {
  input: { action: "authorize" },
  toolCallId: "call-auth",
  toolName: "protected_action",
  type: "tool-call" as const,
};

const signInResult = {
  output: { type: "text" as const, value: "Authorization required." },
  toolCallId: signInCall.toolCallId,
  toolName: signInCall.toolName,
  type: "tool-result" as const,
};

const siblingCall = {
  input: { action: "complete" },
  toolCallId: "call-sibling",
  toolName: "protected_action",
  type: "tool-call" as const,
};

const siblingResult = {
  output: { type: "text" as const, value: "completed" },
  toolCallId: siblingCall.toolCallId,
  toolName: siblingCall.toolName,
  type: "tool-result" as const,
};

describe("withoutCalls", () => {
  it("removes a stopped call, its result, and the assistant text that narrated it", () => {
    const messages: ModelMessage[] = [
      { content: "Check the weather.", role: "user" },
      {
        content: [{ text: "I'll authorize this action.", type: "text" }, signInCall],
        role: "assistant",
      },
      { content: [signInResult], role: "tool" },
    ];

    expect(withoutCalls(messages, new Set([signInCall.toolCallId]))).toEqual([messages[0]]);
  });

  it("keeps sibling calls and their results", () => {
    const messages: ModelMessage[] = [
      { content: [signInCall, siblingCall], role: "assistant" },
      { content: [signInResult, siblingResult], role: "tool" },
    ];

    expect(withoutCalls(messages, new Set([signInCall.toolCallId]))).toEqual([
      { content: [siblingCall], role: "assistant" },
      { content: [siblingResult], role: "tool" },
    ]);
  });
});
