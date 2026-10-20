import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";
import {
  chargeModelRequest,
  remainingTurnMs,
  resolveTurnLimits,
  TurnLimitReachedError,
} from "#harness/turn-limits.js";

const session: Pick<HarnessSession, "state"> = { state: {} };

function charge(
  from: Pick<HarnessSession, "state">,
  times: number,
  input: Parameters<typeof chargeModelRequest>[1],
) {
  let next = from;
  for (let i = 0; i < times; i++) next = chargeModelRequest(next, input);
  return next;
}

describe("turn limits", () => {
  it("resolves only numeric limits", () => {
    expect(resolveTurnLimits(undefined)).toBeUndefined();
    expect(
      resolveTurnLimits({ maxModelRequestsPerTurn: false, turnTimeoutMs: false }),
    ).toBeUndefined();
    expect(resolveTurnLimits({ maxModelRequestsPerTurn: 3 })).toEqual({
      maxModelRequestsPerTurn: 3,
    });
  });

  it("leaves the session untouched without limits", () => {
    expect(chargeModelRequest(session, { limits: undefined, turnId: "t1" })).toBe(session);
  });

  it("refuses the request after the allowance is spent", () => {
    const input = { limits: { maxModelRequestsPerTurn: 2 }, now: 0, turnId: "t1" };
    const spent = charge(session, 2, input);

    expect(() => chargeModelRequest(spent, input)).toThrow(
      expect.objectContaining({
        code: "TURN_LIMIT_REACHED",
        details: { kind: "model-requests", limit: 2 },
      }),
    );
  });

  it("starts a fresh allowance for a new turn", () => {
    const spent = charge(session, 1, { limits: { maxModelRequestsPerTurn: 1 }, turnId: "t1" });

    expect(() =>
      chargeModelRequest(spent, { limits: { maxModelRequestsPerTurn: 1 }, turnId: "t2" }),
    ).not.toThrow();
  });

  it("keeps the deadline from the turn's first request", () => {
    const limits = { turnTimeoutMs: 1_000 };
    const started = chargeModelRequest(session, { limits, now: 100, turnId: "t1" });

    expect(remainingTurnMs(started, { limits, now: 600, turnId: "t1" })).toBe(500);
    expect(() => chargeModelRequest(started, { limits, now: 1_100, turnId: "t1" })).toThrow(
      TurnLimitReachedError,
    );
    expect(remainingTurnMs(started, { limits, now: 5_000, turnId: "t1" })).toBe(0);
  });
});
