import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionTimeoutControl } from "#execution/session/timeout-control.js";
import {
  cancelSessionTimeoutStep,
  startSessionTimeoutStep,
} from "#execution/session/timeout-steps.js";

vi.mock("./timeout-steps.js", () => ({
  cancelSessionTimeoutStep: vi.fn(),
  startSessionTimeoutStep: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
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
      sessionId: "wrun_1",
    });
    await control.start();
    await control.start();

    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(startSessionTimeoutStep).toHaveBeenCalledWith({
      deadline,
      ownerRunId: "owner-1",
      token: "eve:session:wrun_1:inbox",
    });
  });

  it("shares in-progress startup across concurrent start calls", async () => {
    let resolveStartup!: (value: { runId: string }) => void;
    vi.mocked(startSessionTimeoutStep).mockReturnValue(
      new Promise((resolve) => {
        resolveStartup = resolve;
      }),
    );
    const control = createSessionTimeoutControl({
      deadline: new Date("2026-02-01T00:00:00.000Z"),
      sessionId: "wrun_1",
    });

    const first = control.start();
    const second = control.start();
    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
    resolveStartup({ runId: "timer-run" });
    await Promise.all([first, second]);

    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
  });

  it("waits for in-progress startup before cancelling", async () => {
    let resolveStartup!: (value: { runId: string }) => void;
    vi.mocked(startSessionTimeoutStep).mockReturnValue(
      new Promise((resolve) => {
        resolveStartup = resolve;
      }),
    );
    const control = createSessionTimeoutControl({
      deadline: new Date("2026-02-01T00:00:00.000Z"),
      sessionId: "wrun_1",
    });

    const startup = control.start();
    const disposal = control.dispose();
    expect(cancelSessionTimeoutStep).not.toHaveBeenCalled();
    resolveStartup({ runId: "timer-run" });
    await Promise.all([startup, disposal]);

    expect(cancelSessionTimeoutStep).toHaveBeenCalledWith({ runId: "timer-run" });
  });

  it("cancels the active timer when the session settles", async () => {
    vi.mocked(startSessionTimeoutStep).mockResolvedValue({ runId: "timer-run" });
    const control = createSessionTimeoutControl({
      deadline: new Date("2026-02-01T00:00:00.000Z"),
      sessionId: "wrun_1",
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
      sessionId: "wrun_1",
    });

    await expect(control.start()).rejects.toBe(failure);
    await expect(control.start()).rejects.toBe(failure);
    await control.dispose();

    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(cancelSessionTimeoutStep).not.toHaveBeenCalled();
  });
});
