import { describe, expect, it } from "vitest";

import { parseCancelTurnBody } from "#eve-channel/request.js";

describe("parseCancelTurnBody", () => {
  it("parses session-owned task cancellation", async () => {
    const result = await parseCancelTurnBody(
      new Request("https://eve.test/eve/v1/session/session_1/cancel", {
        body: JSON.stringify({ tasks: true, turnId: "turn_1" }),
        method: "POST",
      }),
    );

    expect(result).toEqual({ tasks: true, turnId: "turn_1" });
  });

  it.each([null, 1, "true", []])("rejects a non-boolean tasks value %o", async (tasks) => {
    const result = await parseCancelTurnBody(
      new Request("https://eve.test/eve/v1/session/session_1/cancel", {
        body: JSON.stringify({ tasks }),
        method: "POST",
      }),
    );

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({
      error: "Expected 'tasks' to be a boolean.",
      ok: false,
    });
  });
});
