import { describe, expect, it } from "vitest";

import {
  createSessionLimitContinuationRequest,
  isSessionLimitContinuationRequest,
  isSessionLimitContinuationRequestId,
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
          description: "Grant a fresh token budget",
          id: "continue",
          label: "Approve",
          style: "primary",
        },
        {
          description: "Stop now",
          id: "stop",
          label: "Stop",
          style: "danger",
        },
      ],
      prompt:
        "This session has hit the input-token limit (40M) per session. This is a guardrail " +
        "against defective long-running sessions. If session activity looks fine, just " +
        "approve to keep going.",
      requestId: "sess-test:limit:input:40120500",
    });
  });

  it("formats the limit compactly in the prompt copy", () => {
    const promptFor = (limit: number): string =>
      createSessionLimitContinuationRequest({
        sessionId: "sess-test",
        totalUsedTokens: limit + 1,
        violation: { kind: "input", limit, usedTokens: limit + 1 },
      }).prompt;

    expect(promptFor(2_000_000)).toContain("(2M)");
    expect(promptFor(1_872_014)).toContain("(1.9M)");
    expect(promptFor(200_000)).toContain("(200K)");
    expect(promptFor(1_500)).toContain("(1.5K)");
    expect(promptFor(999)).toContain("(999)");
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

  it("mints ids recognized by isSessionLimitContinuationRequestId", () => {
    expect(isSessionLimitContinuationRequestId(createTestRequest().requestId)).toBe(true);
    expect(isSessionLimitContinuationRequestId("sess-test:limit:output:12")).toBe(true);
    expect(isSessionLimitContinuationRequestId("approval-1")).toBe(false);
    expect(isSessionLimitContinuationRequestId("sess-test:limit:input:")).toBe(false);
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
