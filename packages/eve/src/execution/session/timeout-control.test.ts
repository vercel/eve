import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionTimeoutControl,
  type SessionTimeoutControl,
} from "#execution/session/timeout-control.js";
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

const BOOT = new Date("2026-02-01T00:00:00.000Z");
const TIMEOUT_MS = 60_000;

function createControl(): SessionTimeoutControl {
  const control = createSessionTimeoutControl({ sessionId: "wrun_1", timeoutMs: TIMEOUT_MS });
  if (control === undefined) throw new Error("expected a timeout control");
  return control;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BOOT);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("createSessionTimeoutControl", () => {
  it("arms one timer for the idle window against the stable command inbox", async () => {
    vi.mocked(startSessionTimeoutStep).mockResolvedValue({ runId: "timer-run" });

    const control = createControl();
    await control.start();
    await control.start();

    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(startSessionTimeoutStep).toHaveBeenCalledWith({
      deadline: new Date(BOOT.getTime() + TIMEOUT_MS),
      ownerRunId: "owner-1",
      token: "eve:session:wrun_1:inbox",
    });
  });

  it("preserves an inherited idle deadline until real activity renews it", async () => {
    const deadline = new Date(BOOT.getTime() + 20_000);
    vi.mocked(startSessionTimeoutStep).mockResolvedValue({ runId: "timer-run" });
    const control = createSessionTimeoutControl({
      deadline,
      sessionId: "wrun_1",
      timeoutMs: TIMEOUT_MS,
    })!;
    expect(control.getDeadline()).toEqual(deadline);
    await control.start();
    expect(startSessionTimeoutStep).toHaveBeenCalledWith(expect.objectContaining({ deadline }));
    vi.setSystemTime(deadline);
    await expect(control.handleTimerElapsed()).resolves.toBe("expired");

    control.recordActivity();
    expect(control.getDeadline()).toEqual(new Date(deadline.getTime() + TIMEOUT_MS));
    await expect(control.handleTimerElapsed()).resolves.toBe("extended");
    expect(startSessionTimeoutStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ deadline: new Date(deadline.getTime() + TIMEOUT_MS) }),
    );
  });

  it("extends the deadline from the latest activity instead of expiring", async () => {
    vi.mocked(startSessionTimeoutStep)
      .mockResolvedValueOnce({ runId: "timer-1" })
      .mockResolvedValueOnce({ runId: "timer-2" });
    const control = createControl();
    await control.start();

    vi.setSystemTime(BOOT.getTime() + 40_000);
    control.recordActivity();
    vi.setSystemTime(BOOT.getTime() + TIMEOUT_MS);

    await expect(control.handleTimerElapsed()).resolves.toBe("extended");
    expect(startSessionTimeoutStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ deadline: new Date(BOOT.getTime() + 40_000 + TIMEOUT_MS) }),
    );
    // The elapsed timer already ended; only its replacement is cancelled.
    await control.dispose();
    expect(cancelSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(cancelSessionTimeoutStep).toHaveBeenCalledWith({ runId: "timer-2" });
  });

  it("expires once the session has been idle for the whole window", async () => {
    vi.mocked(startSessionTimeoutStep).mockResolvedValue({ runId: "timer-run" });
    const control = createControl();
    await control.start();

    vi.setSystemTime(BOOT.getTime() + TIMEOUT_MS);

    await expect(control.handleTimerElapsed()).resolves.toBe("expired");
    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
  });

  it("shares in-progress startup across concurrent start calls", async () => {
    let resolveStartup!: (value: { runId: string }) => void;
    vi.mocked(startSessionTimeoutStep).mockReturnValue(
      new Promise((resolve) => {
        resolveStartup = resolve;
      }),
    );
    const control = createControl();

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
    const control = createControl();

    const startup = control.start();
    const disposal = control.dispose();
    expect(cancelSessionTimeoutStep).not.toHaveBeenCalled();
    resolveStartup({ runId: "timer-run" });
    await Promise.all([startup, disposal]);

    expect(cancelSessionTimeoutStep).toHaveBeenCalledWith({ runId: "timer-run" });
  });

  it("cancels the active timer when the session settles", async () => {
    vi.mocked(startSessionTimeoutStep).mockResolvedValue({ runId: "timer-run" });
    const control = createControl();

    await control.start();
    await control.dispose();
    await control.dispose();

    expect(cancelSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(cancelSessionTimeoutStep).toHaveBeenCalledWith({ runId: "timer-run" });
  });

  it("propagates timer startup failures", async () => {
    const failure = new Error("timer startup failed");
    vi.mocked(startSessionTimeoutStep).mockRejectedValue(failure);

    const control = createControl();

    await expect(control.start()).rejects.toBe(failure);
    await expect(control.start()).rejects.toBe(failure);
    await control.dispose();

    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(cancelSessionTimeoutStep).not.toHaveBeenCalled();
  });
});
