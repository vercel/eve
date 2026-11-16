import type { SessionStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import { getLatestTurnFailure } from "./turn-failure";

describe("turn failures", () => {
  it("keeps a parked failed child visibly failed", () => {
    const events = [
      {
        data: {
          error: { code: "CHILD_FAILED", message: "Child failed." },
          outcome: "failed",
          turnId: "child-turn",
        },
        meta: {
          at: "2026-08-27T20:00:00.000Z",
          endOfLine: false,
          position: { index: 0, line: 4 },
        },
        scope: { turnId: "child-turn" },
        type: "turn.settled",
      },
      {
        data: {
          deliveryId: "delivery-1",
          outcome: "failed",
          turnId: "child-turn",
        },
        meta: {
          at: "2026-08-27T20:00:00.000Z",
          endOfLine: true,
          position: { index: 1, line: 4 },
        },
        type: "delivery.settled",
      },
    ] satisfies SessionStreamEvent[];

    expect(getLatestTurnFailure(events)).toBe("Child failed.");
  });

  it("reports a session failure that cancelled the turn", () => {
    const events = [
      {
        data: { outcome: "cancelled", turnId: "turn-1" },
        meta: {
          at: "2026-08-27T20:00:00.000Z",
          endOfLine: false,
          position: { index: 0, line: 2 },
        },
        scope: { turnId: "turn-1" },
        type: "turn.settled",
      },
      {
        data: {
          error: { code: "MODEL_CALL_FAILED", message: "Provider failed." },
          outcome: "failed",
        },
        meta: {
          at: "2026-08-27T20:00:00.000Z",
          endOfLine: true,
          position: { index: 1, line: 2 },
        },
        type: "session.ended",
      },
    ] satisfies SessionStreamEvent[];

    expect(getLatestTurnFailure(events)).toBe(
      "The model is temporarily unavailable. Please try again."
    );
  });
});
