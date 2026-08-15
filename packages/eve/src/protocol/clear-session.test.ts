import { describe, expect, it } from "vitest";

import { ClearResponseSchema } from "#protocol/clear-session.js";

describe("ClearResponseSchema", () => {
  it("accepts both successful outcomes", () => {
    expect(
      ClearResponseSchema.parse({ ok: true, sessionId: "sess_1", status: "accepted" }),
    ).toEqual({ ok: true, sessionId: "sess_1", status: "accepted" });
    expect(ClearResponseSchema.parse({ ok: true, status: "no_active_session" })).toEqual({
      ok: true,
      status: "no_active_session",
    });
  });

  it("requires a session id for accepted requests", () => {
    expect(ClearResponseSchema.safeParse({ ok: true, status: "accepted" }).success).toBe(false);
  });
});
