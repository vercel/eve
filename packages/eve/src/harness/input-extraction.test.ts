import { describe, expect, it } from "vitest";

import {
  extractQuestionInputRequests,
  extractToolApprovalInputRequests,
} from "#harness/input-extraction.js";

describe("extractQuestionInputRequests", () => {
  it("extracts a question request from an ask_question tool call", () => {
    const result = extractQuestionInputRequests({
      excludedCallIds: new Set(),
      toolCalls: [
        {
          input: {
            options: [{ id: "yes", label: "Yes" }],
            prompt: "Continue?",
          },
          toolCallId: "call-1",
          toolName: "ask_question",
          type: "tool-call",
        },
      ],
    });

    expect(result).toEqual([
      {
        action: {
          callId: "call-1",
          input: {
            options: [{ id: "yes", label: "Yes" }],
            prompt: "Continue?",
          },
          kind: "tool-call",
          toolName: "ask_question",
        },
        display: "select",
        options: [{ id: "yes", label: "Yes" }],
        prompt: "Continue?",
        requestId: "call-1",
      },
    ]);
  });

  it("includes allowFreeform when present in the tool input", () => {
    const result = extractQuestionInputRequests({
      excludedCallIds: new Set(),
      toolCalls: [
        {
          input: { allowFreeform: true, prompt: "What do you want?" },
          toolCallId: "call-1",
          toolName: "ask_question",
          type: "tool-call",
        },
      ],
    });

    expect(result[0]?.allowFreeform).toBe(true);
  });

  it("skips non-ask_question tool calls", () => {
    const result = extractQuestionInputRequests({
      excludedCallIds: new Set(),
      toolCalls: [
        {
          input: { a: 1 },
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-call",
        },
      ],
    });

    expect(result).toEqual([]);
  });

  it("skips tool calls present in the excluded set", () => {
    const result = extractQuestionInputRequests({
      excludedCallIds: new Set(["call-1"]),
      toolCalls: [
        {
          input: { prompt: "Continue?" },
          toolCallId: "call-1",
          toolName: "ask_question",
          type: "tool-call",
        },
      ],
    });

    expect(result).toEqual([]);
  });
});

describe("extractToolApprovalInputRequests", () => {
  it("extracts a tool approval request from content parts", () => {
    const result = extractToolApprovalInputRequests({
      content: [
        {
          approvalId: "approval-1",
          toolCall: {
            input: { command: "rm -rf /tmp" },
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-call",
          },
          type: "tool-approval-request",
        },
      ],
    });

    expect(result).toEqual([
      {
        action: {
          callId: "call-1",
          input: { command: "rm -rf /tmp" },
          kind: "tool-call",
          toolName: "bash",
        },
        allowFreeform: false,
        display: "confirmation",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
        prompt: "Approve tool call: bash",
        requestId: "approval-1",
      },
    ]);
  });

  it("extracts an approval request from a sibling tool call", () => {
    const result = extractToolApprovalInputRequests({
      content: [
        {
          input: { command: "rm -rf /tmp" },
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-call",
        },
        {
          approvalId: "approval-1",
          toolCallId: "call-1",
          type: "tool-approval-request",
        } as never,
      ],
    });

    expect(result).toEqual([
      {
        action: {
          callId: "call-1",
          input: { command: "rm -rf /tmp" },
          kind: "tool-call",
          toolName: "bash",
        },
        allowFreeform: false,
        display: "confirmation",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
        prompt: "Approve tool call: bash",
        requestId: "approval-1",
      },
    ]);
  });

  it("skips automatic approval decisions", () => {
    const result = extractToolApprovalInputRequests({
      content: [
        {
          approvalId: "approval-1",
          isAutomatic: true,
          toolCall: {
            input: { command: "rm -rf /tmp" },
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-call",
          },
          type: "tool-approval-request",
        },
      ],
    });

    expect(result).toEqual([]);
  });

  it("skips approval requests without matching tool-call data", () => {
    const result = extractToolApprovalInputRequests({
      content: [
        {
          approvalId: "approval-1",
          toolCallId: "missing-call",
          type: "tool-approval-request",
        } as never,
      ],
    });

    expect(result).toEqual([]);
  });

  it("skips approval requests for excluded tool calls before parsing input", () => {
    const result = extractToolApprovalInputRequests({
      content: [
        {
          input: [],
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-call",
        } as never,
        {
          approvalId: "approval-1",
          toolCallId: "call-1",
          type: "tool-approval-request",
        } as never,
      ],
      excludedCallIds: new Set(["call-1"]),
    });

    expect(result).toEqual([]);
  });

  it("skips non-approval content parts", () => {
    const result = extractToolApprovalInputRequests({
      content: [
        { text: "Some text.", type: "text" },
        {
          input: {},
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-call",
        },
      ],
    });

    expect(result).toEqual([]);
  });

  it("returns an empty array for empty content", () => {
    expect(extractToolApprovalInputRequests({ content: [] })).toEqual([]);
  });
});
