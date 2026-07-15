import { afterEach, describe, expect, it, vi } from "vitest";

import { requestTurnCancellation } from "#execution/request-turn-cancellation.js";

const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

afterEach(() => {
  resumeHookMock.mockReset();
});

describe("requestTurnCancellation", () => {
  it("resumes the session cancel hook and reports 'cancelling'", async () => {
    resumeHookMock.mockResolvedValue({ runId: "turn-run" });

    await expect(requestTurnCancellation({ sessionId: "wrun_1" })).resolves.toBe("cancelling");

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock).toHaveBeenCalledWith("wrun_1:cancel", {});
  });

  it("forwards the optional turnId guard in the hook payload", async () => {
    resumeHookMock.mockResolvedValue({ runId: "turn-run" });

    await expect(requestTurnCancellation({ sessionId: "wrun_1", turnId: "turn_3" })).resolves.toBe(
      "cancelling",
    );

    expect(resumeHookMock).toHaveBeenCalledWith("wrun_1:cancel", { turnId: "turn_3" });
  });

  it("maps `HookNotFoundError` to the benign 'no_active_turn'", async () => {
    const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
    resumeHookMock.mockRejectedValue(new HookNotFoundError("wrun_1:cancel"));

    await expect(requestTurnCancellation({ sessionId: "wrun_1" })).resolves.toBe("no_active_turn");
  });

  it("re-throws unexpected errors from `resumeHook`", async () => {
    const failure = new Error("transient backing-store outage");
    resumeHookMock.mockRejectedValue(failure);

    await expect(requestTurnCancellation({ sessionId: "wrun_1" })).rejects.toBe(failure);
  });
});
