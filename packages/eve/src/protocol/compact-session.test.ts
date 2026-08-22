import { describe, expect, it } from "vitest";

import { CompactResponseSchema } from "#protocol/compact-session.js";

describe("CompactResponseSchema", () => {
  it("accepts both successful outcomes", () => {
    expect(
      CompactResponseSchema.parse({ ok: true, sessionId: "sess_1", status: "accepted" }),
    ).toEqual({ ok: true, sessionId: "sess_1", status: "accepted" });
    expect(CompactResponseSchema.parse({ ok: true, status: "no_active_session" })).toEqual({
      ok: true,
      status: "no_active_session",
    });
  });

  it("requires a session id for accepted requests", () => {
    expect(CompactResponseSchema.safeParse({ ok: true, status: "accepted" }).success).toBe(false);
  });
});
