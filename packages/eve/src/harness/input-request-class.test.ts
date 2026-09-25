import { describe, expect, it } from "vitest";

import { isApprovalRequest } from "#harness/input-request-class.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";

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
        action: { ...action, toolName: "ask_question" },
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
