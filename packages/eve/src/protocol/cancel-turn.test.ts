import { describe, expect, it } from "vitest";

import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";

describe("CancelTurnResponseSchema", () => {
  it("accepts the asynchronous accepted outcome", () => {
    expect(
      CancelTurnResponseSchema.safeParse({
        ok: true,
        sessionId: "session-1",
        status: "accepted",
      }).success,
    ).toBe(true);
  });

  it("accepts an inactive outcome without a session id", () => {
    expect(CancelTurnResponseSchema.safeParse({ ok: true, status: "no_active_turn" }).success).toBe(
      true,
    );
  });

  it("rejects a session id on an inactive outcome", () => {
    expect(
      CancelTurnResponseSchema.safeParse({
        ok: true,
        sessionId: "session-1",
        status: "no_active_turn",
      }).success,
    ).toBe(false);
  });

  it("rejects the former in-progress wording", () => {
    expect(
      CancelTurnResponseSchema.safeParse({
        ok: true,
        sessionId: "session-1",
        status: "cancelling",
      }).success,
    ).toBe(false);
  });
});
