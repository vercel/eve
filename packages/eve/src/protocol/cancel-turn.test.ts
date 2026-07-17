import { describe, expect, it } from "vitest";

import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";

describe("CancelTurnResponseSchema", () => {
  it.each(["accepted", "no_active_turn"] as const)("accepts the %s outcome", (status) => {
    expect(
      CancelTurnResponseSchema.safeParse({ ok: true, sessionId: "session-1", status }).success,
    ).toBe(true);
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
