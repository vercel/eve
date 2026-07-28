import { describe, expect, it } from "vitest";

import { classifyInputRequest, isApprovalRequest } from "#harness/input-request-class.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
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
        action,
        allowFreeform: true,
        options: [{ id: "blue", label: "Blue" }],
        prompt: "Which color?",
        requestId: "call_1",
      }),
    ).toBe("dismissable");
  });

  it("does not mistake non-approval two-option requests for approvals", () => {
    expect(
      classifyInputRequest({
        action,
        options: [
          { id: "blue", label: "Blue" },
          { id: "red", label: "Red" },
        ],
        prompt: "Which color?",
        requestId: "call_1",
      }),
    ).toBe("dismissable");
  });
});

describe("isApprovalRequest", () => {
  const action = {
    callId: "call_1",
    input: {},
    kind: "tool-call",
    toolName: "bash",
  } as const;

  it("matches exactly the approve/deny option pair, in order", () => {
    const options = (ids: readonly string[]) => ids.map((id) => ({ id, label: id }));

    expect(
      isApprovalRequest({
        action,
        options: options(["approve", "deny"]),
        prompt: "?",
        requestId: "r",
      }),
    ).toBe(true);
    expect(
      isApprovalRequest({
        action,
        options: options(["deny", "approve"]),
        prompt: "?",
        requestId: "r",
      }),
    ).toBe(false);
    expect(
      isApprovalRequest({ action, options: options(["approve"]), prompt: "?", requestId: "r" }),
    ).toBe(false);
    expect(isApprovalRequest({ action, prompt: "?", requestId: "r" })).toBe(false);
  });
});
