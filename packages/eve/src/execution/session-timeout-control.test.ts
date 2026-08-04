import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import {
  cancelSessionTimeoutStep,
  startSessionTimeoutStep,
} from "#execution/session-timeout-steps.js";

vi.mock("./session-timeout-steps.js", () => ({
  cancelSessionTimeoutStep: vi.fn(),
  startSessionTimeoutStep: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("createSessionTimeoutControl", () => {
  it("retargets one absolute deadline when the delivery hook is rekeyed", async () => {
    const deadline = new Date("2026-02-01T00:00:00.000Z");
    vi.mocked(startSessionTimeoutStep)
      .mockResolvedValueOnce({ runId: "timer-old" })
      .mockResolvedValueOnce({ runId: "timer-new" });
    const control = createSessionTimeoutControl({ deadline });

    await control.rekey("old");
    await control.rekey("old");
    await control.rekey("replacement");

    expect(startSessionTimeoutStep).toHaveBeenNthCalledWith(1, {
      deadline,
      token: "old",
    });
    expect(startSessionTimeoutStep).toHaveBeenNthCalledWith(2, {
      deadline,
      token: "replacement",
    });
    expect(cancelSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(cancelSessionTimeoutStep).toHaveBeenCalledWith({ runId: "timer-old" });
    expect(vi.mocked(cancelSessionTimeoutStep).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(startSessionTimeoutStep).mock.invocationCallOrder[1]!,
    );
  });

  it("cancels the active timer when the session settles", async () => {
    vi.mocked(startSessionTimeoutStep).mockResolvedValue({ runId: "timer-run" });
    const control = createSessionTimeoutControl({
      deadline: new Date("2026-02-01T00:00:00.000Z"),
    });

    await control.rekey("active");
    await control.dispose();
    await control.dispose();

    expect(cancelSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(cancelSessionTimeoutStep).toHaveBeenCalledWith({ runId: "timer-run" });
  });

  it("does not start a timer without a continuation token", async () => {
    const control = createSessionTimeoutControl({
      deadline: new Date("2026-02-01T00:00:00.000Z"),
    });

    await control.rekey("");
    await control.dispose();

    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
    expect(cancelSessionTimeoutStep).not.toHaveBeenCalled();
  });

  it("propagates timer startup failures", async () => {
    const failure = new Error("timer startup failed");
    vi.mocked(startSessionTimeoutStep).mockRejectedValue(failure);
    const control = createSessionTimeoutControl({
      deadline: new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(control.rekey("active")).rejects.toBe(failure);
    await control.dispose();

    expect(cancelSessionTimeoutStep).not.toHaveBeenCalled();
  });
});
