import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelSessionTimeout,
  signalSessionTimeoutStep,
  startSessionTimeout,
} from "#execution/session-timeout-steps.js";
import { sessionTimeoutWorkflowReference } from "#execution/workflow-references.js";

const cancelRunMock = vi.fn();
const getWorldMock = vi.fn();
const dispatchMock = vi.fn();
const startMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  cancelRun: (...args: unknown[]) => cancelRunMock(...args),
  getWorld: (...args: unknown[]) => getWorldMock(...args),
  start: (...args: unknown[]) => startMock(...args),
}));

vi.mock("#execution/workflow-references.js", () => ({
  sessionTimeoutWorkflowReference: { workflowId: "workflow//eve//sessionTimeoutWorkflow" },
}));

afterEach(() => {
  cancelRunMock.mockReset();
  getWorldMock.mockReset();
  dispatchMock.mockReset();
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

    await expect(startSessionTimeout(input)).resolves.toEqual({ runId: "timer-run" });
    expect(startMock).toHaveBeenCalledWith(sessionTimeoutWorkflowReference, [input]);
  });

  it("admits a session expiry candidate with a stable event identity", async () => {
    dispatchMock.mockResolvedValue({ runId: "session-1" });

    await signalSessionTimeoutStep({ token: "session-1:session-timeout" });

    expect(dispatchMock).toHaveBeenCalledWith(
      "session-1:session-timeout",
      {
        kind: "session-timeout",
      },
      "expiry:session-1:session-timeout",
    );
  });

  it("ignores a signal after the owning session is gone", async () => {
    const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
    dispatchMock.mockRejectedValue(new HookNotFoundError("session-1:session-timeout"));

    await expect(
      signalSessionTimeoutStep({ token: "session-1:session-timeout" }),
    ).resolves.toBeUndefined();
  });

  it("cancels a timer that is no longer needed", async () => {
    const world = {};
    getWorldMock.mockResolvedValue(world);
    cancelRunMock.mockResolvedValue(undefined);

    await cancelSessionTimeout({ runId: "timer-run" });

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

    await expect(cancelSessionTimeout({ runId: "timer-run" })).resolves.toBeUndefined();
  });

  it("propagates unexpected timeout runtime failures", async () => {
    const signalFailure = new Error("resume failed");
    dispatchMock.mockRejectedValue(signalFailure);
    await expect(signalSessionTimeoutStep({ token: "session-1:session-timeout" })).rejects.toBe(
      signalFailure,
    );

    const cancelFailure = new Error("cancel failed");
    getWorldMock.mockResolvedValue({});
    cancelRunMock.mockRejectedValue(cancelFailure);
    await expect(cancelSessionTimeout({ runId: "timer-run" })).rejects.toBe(cancelFailure);
  });
});

vi.mock("#execution/session/ingress.js", () => ({
  dispatchSessionCommandByToken: (...args: unknown[]) => dispatchMock(...args),
}));
vi.mock("#execution/workflow-start.js", () => ({
  startWorkflowOnCurrentDeployment: (...args: unknown[]) => startMock(...args),
}));
