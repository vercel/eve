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

  it.each([
    [{ taskId: "remind-q4x1ze" }, { taskId: "remind-q4x1ze" }],
    [{ tasks: true }, { tasks: true }],
    [
      { tasks: false, turnId: "turn_1" },
      { tasks: false, turnId: "turn_1" },
    ],
  ])("parses the task options %o", async (body, parsed) => {
    await expect(parseCancelTurnBody(cancelRequest(body))).resolves.toEqual(parsed);
  });

  it.each([
    [{ taskId: "" }, "Expected 'taskId' to be a non-empty string of at most 128 characters."],
    [{ taskId: 7 }, "Expected 'taskId' to be a non-empty string of at most 128 characters."],
    [
      { taskId: "x".repeat(129) },
      "Expected 'taskId' to be a non-empty string of at most 128 characters.",
    ],
    [{ tasks: "yes" }, "Expected 'tasks' to be a boolean."],
    [
      { taskId: "remind-q4x1ze", tasks: true },
      "'taskId' cancels one task and leaves the turn running, so it cannot be combined with 'tasks' or 'turnId'.",
    ],
    [
      { taskId: "remind-q4x1ze", turnId: "turn_1" },
      "'taskId' cancels one task and leaves the turn running, so it cannot be combined with 'tasks' or 'turnId'.",
    ],
  ])("rejects %o", async (body, error) => {
    const result = await parseCancelTurnBody(cancelRequest(body));

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({ error, ok: false });
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

function cancelRequest(body: Record<string, unknown>): Request {
  return new Request("https://eve.test/eve/v1/session/session_1/cancel", {
    body: JSON.stringify(body),
    method: "POST",
  });
}
