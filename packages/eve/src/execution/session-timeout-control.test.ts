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
  it("starts one absolute deadline against the stable command inbox", async () => {
    const deadline = new Date("2026-02-01T00:00:00.000Z");
    vi.mocked(startSessionTimeoutStep).mockResolvedValue({ runId: "timer-run" });

    const control = createSessionTimeoutControl({
      deadline,
      token: "eve:session:wrun_1:inbox",
    });
    await control.start();
    await control.start();

    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(startSessionTimeoutStep).toHaveBeenCalledWith({
      deadline,
      token: "eve:session:wrun_1:inbox",
    });
  });

  it("cancels the active timer when the session settles", async () => {
    vi.mocked(startSessionTimeoutStep).mockResolvedValue({ runId: "timer-run" });
    const control = createSessionTimeoutControl({
      deadline: new Date("2026-02-01T00:00:00.000Z"),
      token: "eve:session:wrun_1:inbox",
    });

    await control.start();
    await control.dispose();
    await control.dispose();

    expect(cancelSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(cancelSessionTimeoutStep).toHaveBeenCalledWith({ runId: "timer-run" });
  });

  it("propagates timer startup failures", async () => {
    const failure = new Error("timer startup failed");
    vi.mocked(startSessionTimeoutStep).mockRejectedValue(failure);

    const control = createSessionTimeoutControl({
      deadline: new Date("2026-02-01T00:00:00.000Z"),
      token: "eve:session:wrun_1:inbox",
    });

    await expect(control.start()).rejects.toBe(failure);
    await control.dispose();

    expect(cancelSessionTimeoutStep).not.toHaveBeenCalled();
  });
});
