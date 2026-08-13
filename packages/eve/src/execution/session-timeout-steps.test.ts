import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelSessionTimeoutStep,
  signalSessionTimeoutStep,
  startSessionTimeoutStep,
} from "#execution/session-timeout-steps.js";
import { sessionTimeoutWorkflowReference } from "#execution/workflow-runtime.js";

const cancelRunMock = vi.fn();
const getWorldMock = vi.fn();
const resumeHookMock = vi.fn();
const startMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  cancelRun: (...args: unknown[]) => cancelRunMock(...args),
  getWorld: (...args: unknown[]) => getWorldMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
  start: (...args: unknown[]) => startMock(...args),
}));

afterEach(() => {
  cancelRunMock.mockReset();
  getWorldMock.mockReset();
  resumeHookMock.mockReset();
  startMock.mockReset();
  vi.unstubAllEnvs();
});

describe("session timeout steps", () => {
  it("starts the durable timer workflow", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    startMock.mockResolvedValue({ runId: "timer-run" });
    const input = {
      deadline: new Date("2026-02-01T00:00:00.000Z"),
      token: "session-1:session-timeout",
    };

    await expect(startSessionTimeoutStep(input)).resolves.toEqual({ runId: "timer-run" });
    expect(startMock).toHaveBeenCalledWith(sessionTimeoutWorkflowReference, [input], {
      deploymentId: "latest",
    });
  });

  it("signals the owning session hook", async () => {
    resumeHookMock.mockResolvedValue({ runId: "session-1" });

    await signalSessionTimeoutStep({ token: "session-1:session-timeout" });

    expect(resumeHookMock).toHaveBeenCalledWith("session-1:session-timeout", {
      kind: "session-timeout",
    });
  });

  it("ignores a signal after the owning session is gone", async () => {
    const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
    resumeHookMock.mockRejectedValue(new HookNotFoundError("session-1:session-timeout"));

    await expect(
      signalSessionTimeoutStep({ token: "session-1:session-timeout" }),
    ).resolves.toBeUndefined();
  });

  it("cancels a timer that is no longer needed", async () => {
    const world = {};
    getWorldMock.mockResolvedValue(world);
    cancelRunMock.mockResolvedValue(undefined);

    await cancelSessionTimeoutStep({ runId: "timer-run" });

    expect(cancelRunMock).toHaveBeenCalledWith(world, "timer-run", {
      cancelReason: "Session ended before its timeout",
    });
  });

  it("ignores a timer that already reached a terminal state", async () => {
    const { RunExpiredError } = await import("#compiled/@workflow/errors/index.js");
    getWorldMock.mockResolvedValue({});
    cancelRunMock.mockRejectedValue(
      new Error("Failed to cancel timer", {
        cause: new RunExpiredError("timer already completed"),
      }),
    );

    await expect(cancelSessionTimeoutStep({ runId: "timer-run" })).resolves.toBeUndefined();
  });

  it("propagates unexpected timeout runtime failures", async () => {
    const signalFailure = new Error("resume failed");
    resumeHookMock.mockRejectedValue(signalFailure);
    await expect(signalSessionTimeoutStep({ token: "session-1:session-timeout" })).rejects.toBe(
      signalFailure,
    );

    const cancelFailure = new Error("cancel failed");
    getWorldMock.mockResolvedValue({});
    cancelRunMock.mockRejectedValue(cancelFailure);
    await expect(cancelSessionTimeoutStep({ runId: "timer-run" })).rejects.toBe(cancelFailure);
  });
});
