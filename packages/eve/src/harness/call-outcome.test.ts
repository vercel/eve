import { describe, expect, it } from "vitest";

import { callOutcomeOf } from "#harness/call-outcome.js";

describe("callOutcomeOf", () => {
  it("uses a failed result's error code", () => {
    expect(
      callOutcomeOf({
        callId: "call_gh",
        errorCode: "token_rejected_after_authorization",
        errorName: "ConnectionAuthorizationFailedError",
        isError: true,
        kind: "tool-result",
        output: "rejected",
        toolName: "gh",
      }),
    ).toEqual({
      error: {
        code: "token_rejected_after_authorization",
        message: "rejected",
        name: "ConnectionAuthorizationFailedError",
      },
      outcome: "failed",
    });
  });

  it("falls back to ACTION_RESULT_FAILED without a code", () => {
    expect(
      callOutcomeOf({
        callId: "call_gh",
        errorName: "Error",
        isError: true,
        kind: "tool-result",
        output: "boom",
        toolName: "gh",
      }),
    ).toEqual({
      error: { code: "ACTION_RESULT_FAILED", message: "boom", name: "Error" },
      outcome: "failed",
    });
  });
});
