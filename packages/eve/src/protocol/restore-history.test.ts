import { describe, expect, it } from "vitest";

import {
  RestoreHistoryRequestSchema,
  RestoreHistoryResponseSchema,
} from "#protocol/restore-history.js";

describe("history restoration protocol", () => {
  it("accepts a nonnegative history index", () => {
    expect(RestoreHistoryRequestSchema.parse({ to: 0 })).toEqual({ to: 0 });
  });

  it.each([-1, 1.5, "1"])("rejects invalid history index %s", (to) => {
    expect(RestoreHistoryRequestSchema.safeParse({ to }).success).toBe(false);
  });

  it("accepts both successful outcomes", () => {
    expect(
      RestoreHistoryResponseSchema.parse({
        ok: true,
        sessionId: "sess_1",
        status: "accepted",
      }),
    ).toEqual({ ok: true, sessionId: "sess_1", status: "accepted" });
    expect(RestoreHistoryResponseSchema.parse({ ok: true, status: "no_active_session" })).toEqual({
      ok: true,
      status: "no_active_session",
    });
  });
});
