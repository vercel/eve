import { describe, expect, it } from "vitest";
import {
  createSessionLimitContinuationRequest,
  isSessionLimitContinuationRequestId,
  limitDecision,
} from "#harness/hitl/budget-request.js";

describe("session usage continuation", () => {
  it("keeps the prompt stable within a turn and window, but changes it for either boundary", () => {
    const input = { sessionId: "alice", turnSequence: 2, windowIndex: 3 };
    const ask = createSessionLimitContinuationRequest(input);
    expect(ask).toEqual(createSessionLimitContinuationRequest(input));
    expect(ask.interactionId).toBe("alice:2:limit:usage:3");
    expect(ask.request).toMatchObject({
      kind: "budget",
      allowFreeform: false,
      options: [{ id: "approve" }, { id: "deny" }],
    });
    expect(
      createSessionLimitContinuationRequest({ ...input, windowIndex: 4 }).interactionId,
    ).not.toBe(ask.interactionId);
    expect(
      createSessionLimitContinuationRequest({ ...input, turnSequence: 3 }).interactionId,
    ).not.toBe(ask.interactionId);
  });

  it.each([
    ["alice:2:limit:usage:3", true],
    ["alice:2:limit:input:12", true],
    ["alice:2:limit:token-cost:1.5", true],
    ["alice:2:limit:usage:", false],
    ["approval-1", false],
  ])("recognizes the budget response marker %s", (id, expected) => {
    expect(isSessionLimitContinuationRequestId(id)).toBe(expected);
  });

  it("grants on approve, declines on deny, and leaves other responses unanswered", () => {
    expect(limitDecision({ optionId: "approve" })).toEqual({ granted: true });
    expect(limitDecision({ optionId: "deny" })).toEqual({ granted: false });
    expect(limitDecision({ text: "sure" })).toBeUndefined();
  });
});
