import { describe, expect, it } from "vitest";

import { extractToolApprovalInputRequests } from "#harness/input-extraction.js";

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
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
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
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
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
