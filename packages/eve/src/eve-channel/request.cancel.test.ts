import { describe, expect, it } from "vitest";

import { parseCancelTurnBody } from "#eve-channel/request.js";

describe("parseCancelTurnBody", () => {
  it("parses a turn cancellation", async () => {
    const result = await parseCancelTurnBody(
      new Request("https://eve.test/eve/v1/session/session_1/cancel", {
        body: JSON.stringify({ turnId: "turn_1" }),
        method: "POST",
      }),
    );

    expect(result).toEqual({ turnId: "turn_1" });
  });

  it.each([null, 1, ""])("rejects an invalid turnId %o", async (turnId) => {
    const result = await parseCancelTurnBody(
      new Request("https://eve.test/eve/v1/session/session_1/cancel", {
        body: JSON.stringify({ turnId }),
        method: "POST",
      }),
    );

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({
      error: "Expected 'turnId' to be a non-empty string.",
      ok: false,
    });
  });
});
