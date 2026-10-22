import { describe, expect, it } from "vitest";

import {
  createSessionLimitContinuationRequest,
  isSessionLimitContinuationRequest,
  isSessionLimitContinuationRequestId,
  resolveSessionLimitContinuation,
} from "#harness/hitl/budget-request.js";

const TOTAL = {
  cacheReadTokens: 500,
  cacheWriteTokens: 0,
  inputTokens: 40_120_000,
  outputTokens: 500,
} as const;
const WINDOW = {
  cacheReadTokens: 500,
  cacheWriteTokens: 0,
  inputTokens: 40_000_500,
  outputTokens: 20,
} as const;

const PROMPT =
  "This session has hit its usage limit. This is a guardrail against defective " +
  "long-running sessions. If session activity looks fine, just approve to keep going.";

function createTestRequest() {
  return createSessionLimitContinuationRequest({
    sessionId: "sess-test",
    total: TOTAL,
    turnSequence: 0,
    window: WINDOW,
    windowIndex: 0,
  });
}

describe("createSessionLimitContinuationRequest", () => {
  it("derives a deterministic request from the usage", () => {
    const first = createTestRequest();
    const second = createTestRequest();

    expect(first).toEqual(second);
    expect(first).toEqual({
      action: {
        callId: "sess-test:0:limit:usage:0",
        input: { total: TOTAL, window: WINDOW },
        kind: "tool-call",
        toolName: "session_limit_continuation",
      },
      allowFreeform: false,
      display: "confirmation",
      kind: "session-limit",
      options: [
        {
          description: "Start a new usage window",
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
      prompt: PROMPT,
      requestId: "sess-test:0:limit:usage:0",
    });
  });

  it("carries a reported cost and omits an unreported one", () => {
    const request = createSessionLimitContinuationRequest({
      sessionId: "sess-test",
      total: { ...TOTAL, costUsd: 1.5123 },
      turnSequence: 0,
      window: WINDOW,
      windowIndex: 0,
    });

    expect(request.action.input).toEqual({ total: { ...TOTAL, costUsd: 1.5123 }, window: WINDOW });
    expect(request.action.input.window).not.toHaveProperty("costUsd");
    expect(request.prompt).toBe(PROMPT);
  });

  it("gives each usage window its own id at the same usage", () => {
    const later = createSessionLimitContinuationRequest({
      sessionId: "sess-test",
      total: TOTAL,
      turnSequence: 0,
      window: WINDOW,
      windowIndex: 1,
    });

    expect(later.requestId).not.toBe(createTestRequest().requestId);
  });

  it("tells the same usage apart across turns", () => {
    const nextTurn = createSessionLimitContinuationRequest({
      sessionId: "sess-test",
      total: TOTAL,
      turnSequence: 1,
      window: WINDOW,
      windowIndex: 0,
    });

    expect(nextTurn.requestId).toBe("sess-test:1:limit:usage:0");
  });

  it("is recognized by isSessionLimitContinuationRequest", () => {
    expect(isSessionLimitContinuationRequest(createTestRequest())).toBe(true);
  });

  it("mints ids recognized by isSessionLimitContinuationRequestId", () => {
    expect(isSessionLimitContinuationRequestId(createTestRequest().requestId)).toBe(true);
    expect(isSessionLimitContinuationRequestId("s:0:limit:usage:5")).toBe(true);
    // Ids minted before the usage-window limit still resolve stale answers.
    expect(isSessionLimitContinuationRequestId("sess-test:0:limit:input:40120500")).toBe(true);
    expect(isSessionLimitContinuationRequestId("sess-test:0:limit:output:12")).toBe(true);
    expect(isSessionLimitContinuationRequestId("sess-test:0:limit:token-cost:1.5123")).toBe(true);
    expect(isSessionLimitContinuationRequestId("approval-1")).toBe(false);
    expect(isSessionLimitContinuationRequestId("sess-test:0:limit:usage:")).toBe(false);
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
    ).toEqual({ granted: true, requestId: request.requestId, windowIndex: 0 });
  });

  it("declines on the stop option", () => {
    expect(
      resolveSessionLimitContinuation({
        requests: [request],
        responses: [{ optionId: "stop", requestId: request.requestId }],
      }),
    ).toEqual({ granted: false, requestId: request.requestId, windowIndex: 0 });
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
