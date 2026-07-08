import { describe, expect, it } from "vitest";

import {
  createSessionLimitContinuationRequest,
  isSessionLimitContinuationRequest,
  resolveSessionLimitContinuation,
} from "#harness/session-limit-continuation.js";

const VIOLATION = { kind: "input", limit: 40_000_000, usedTokens: 40_120_500 } as const;

function createTestRequest() {
  return createSessionLimitContinuationRequest({
    sessionId: "sess-test",
    totalUsedTokens: 40_120_500,
    violation: VIOLATION,
  });
}

describe("createSessionLimitContinuationRequest", () => {
  it("derives a deterministic request from the violation", () => {
    const first = createTestRequest();
    const second = createTestRequest();

    expect(first).toEqual(second);
    expect(first).toEqual({
      action: {
        callId: "sess-test:limit:input:40120500",
        input: { kind: "input", limit: 40_000_000, usedTokens: 40_120_500 },
        kind: "tool-call",
        toolName: "session_limit_continuation",
      },
      allowFreeform: false,
      display: "confirmation",
      options: [
        {
          description: "Reset quota and keep going",
          id: "continue",
          label: "Continue",
          style: "primary",
        },
        {
          description: "End the session here",
          id: "stop",
          label: "Stop",
          style: "danger",
        },
      ],
      prompt:
        "The session used 40,120,500 of its 40,000,000 input-token budget. Continue with a fresh budget?",
      requestId: "sess-test:limit:input:40120500",
    });
  });

  it("gives each violation instance its own id as the session total grows", () => {
    // The absolute total is strictly increasing across grants, so a stale
    // response to an earlier prompt never resolves a later one.
    const later = createSessionLimitContinuationRequest({
      sessionId: "sess-test",
      totalUsedTokens: 80_500_000,
      violation: VIOLATION,
    });

    expect(later.requestId).not.toBe(createTestRequest().requestId);
  });

  it("is recognized by isSessionLimitContinuationRequest", () => {
    expect(isSessionLimitContinuationRequest(createTestRequest())).toBe(true);
  });
});

describe("resolveSessionLimitContinuation", () => {
  const request = createTestRequest();

  it("grants on the continue option", () => {
    expect(
      resolveSessionLimitContinuation({
        requests: [request],
        responses: [{ optionId: "continue", requestId: request.requestId }],
      }),
    ).toEqual({ granted: true });
  });

  it("declines on the stop option", () => {
    expect(
      resolveSessionLimitContinuation({
        requests: [request],
        responses: [{ optionId: "stop", requestId: request.requestId }],
      }),
    ).toEqual({ granted: false });
  });

  it("treats an unanswered or unrecognized response as ignored", () => {
    expect(resolveSessionLimitContinuation({ requests: [request], responses: [] })).toBeUndefined();
    expect(
      resolveSessionLimitContinuation({
        requests: [request],
        responses: [{ requestId: request.requestId, text: "hmm" }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the batch has no continuation request", () => {
    expect(
      resolveSessionLimitContinuation({
        requests: [],
        responses: [{ optionId: "continue", requestId: "other" }],
      }),
    ).toBeUndefined();
  });
});
