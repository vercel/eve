import { describe, expect, it } from "vitest";

import { classifyInputRequest, isApprovalRequest } from "#harness/input-request-class.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import { ASK_QUESTION_TOOL_NAME } from "#runtime/framework-tools/ask-question.js";

describe("classifyInputRequest", () => {
  const action = {
    callId: "call_1",
    input: {},
    kind: "tool-call",
    toolName: "ask_user",
  } as const;

  it("requires an explicit answer for tool approvals", () => {
    expect(
      classifyInputRequest({
        action,
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
        prompt: "Run the tool?",
        requestId: "call_1",
      }),
    ).toBe("required");
  });

  it("requires an explicit answer for session-limit continuations", () => {
    expect(
      classifyInputRequest(
        createSessionLimitContinuationRequest({
          sessionId: "sess-test",
          violation: { kind: "input", limit: 12, usedTokens: 12 },
        }),
      ),
    ).toBe("required");
  });

  it("classifies model questions as dismissable", () => {
    expect(
      classifyInputRequest({
        action: { ...action, toolName: ASK_QUESTION_TOOL_NAME },
        allowFreeform: true,
        kind: "question",
        options: [{ id: "blue", label: "Blue" }],
        prompt: "Which color?",
        requestId: "call_1",
      }),
    ).toBe("dismissable");
  });

  it("does not mistake non-approval two-option requests for approvals", () => {
    const request = {
      action: { ...action, toolName: ASK_QUESTION_TOOL_NAME },
      kind: "question" as const,
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
      prompt: "Should we proceed?",
      requestId: "call_1",
    };

    expect(isApprovalRequest(request)).toBe(false);
    expect(classifyInputRequest(request)).toBe("dismissable");
  });

  it("uses the request kind rather than the action tool name", () => {
    const request = {
      action,
      kind: "question" as const,
      prompt: "What should happen next?",
      requestId: "call_1",
    };

    expect(isApprovalRequest(request)).toBe(false);
    expect(classifyInputRequest(request)).toBe("dismissable");
  });
});

describe("isApprovalRequest", () => {
  const action = {
    callId: "call_1",
    input: {},
    kind: "tool-call",
    toolName: "bash",
  } as const;

  it("distinguishes approval requests from framework-owned input requests", () => {
    expect(
      isApprovalRequest({
        action,
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
        prompt: "?",
        requestId: "r",
      }),
    ).toBe(true);
    expect(
      isApprovalRequest({
        action: { ...action, toolName: ASK_QUESTION_TOOL_NAME },
        kind: "question",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
        prompt: "?",
        requestId: "r",
      }),
    ).toBe(false);
    expect(
      isApprovalRequest(
        createSessionLimitContinuationRequest({
          sessionId: "sess-test",
          violation: { kind: "input", limit: 12, usedTokens: 12 },
        }),
      ),
    ).toBe(false);
  });
});
