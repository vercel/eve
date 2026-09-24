import { describe, expect, it } from "vitest";

import { parseCancelTurnBody } from "#eve-channel/request.js";

describe("parseCancelTurnBody", () => {
  it("parses a turn cancellation", async () => {
    await expect(parseCancelTurnBody(cancelRequest({ turnId: "turn_1" }))).resolves.toEqual({
      turnId: "turn_1",
    });
  });

  it("parses a cancel without options", async () => {
    await expect(parseCancelTurnBody(cancelRequest({}))).resolves.toEqual({});
  });

  it.each([null, 1, ""])("rejects an invalid turnId %o", async (turnId) => {
    const result = await parseCancelTurnBody(cancelRequest({ turnId }));

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({
      error: "Expected 'turnId' to be a non-empty string.",
      ok: false,
    });
  });
});

function cancelRequest(body: Record<string, unknown>): Request {
  return new Request("https://eve.test/eve/v1/session/session_1/cancel", {
    body: JSON.stringify(body),
    method: "POST",
  });
}
