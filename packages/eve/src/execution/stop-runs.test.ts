import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntityConflictError, HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { cancelRun, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { logError } from "#internal/logging.js";
import { stopRuns } from "#execution/stop-runs.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  cancelRun: vi.fn(),
  getRun: vi.fn(),
  getWorld: vi.fn(),
  resumeHook: vi.fn(),
}));

vi.mock("#internal/logging.js", () => ({
  createLogger: vi.fn(() => ({})),
  logError: vi.fn(),
}));

const world = {} as Awaited<ReturnType<typeof getWorld>>;
const address = { hookToken: "generated-control-token", runId: "tool-run" };
const reason = "The calling turn was cancelled.";
const cancel = { kind: "cancel" as const, reason };

describe("stopRuns", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.mocked(getRun).mockReturnValue({ status: Promise.resolve("completed") } as ReturnType<
      typeof getRun
    >);
    vi.mocked(getWorld).mockResolvedValue(world);
  });

  afterEach(() => vi.useRealTimers());

  it("lets a registered workflow cancel cooperatively", async () => {
    await stopRuns([{ ends: true, run: address }], cancel);

    expect(resumeHook).toHaveBeenCalledWith(address.hookToken, { kind: "cancel", reason });
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("allows slow cooperative cleanup before escalating a stuck waiting run", async () => {
    vi.mocked(getRun).mockReturnValue({ status: Promise.resolve("running") } as ReturnType<
      typeof getRun
    >);
    const cancelled = stopRuns([{ ends: true, run: address }], cancel);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cancelRun).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await cancelled;
    expect(cancelRun).toHaveBeenCalledExactlyOnceWith(world, address.runId, {
      cancelReason: reason,
    });
  });

  it("cancels a run whose status can't be read once the deadline passes", async () => {
    vi.mocked(getRun).mockImplementation(() => {
      throw new Error("status unavailable");
    });
    const stopped = stopRuns([{ ends: true, run: address }], cancel);
    await vi.runAllTimersAsync();

    await expect(stopped).resolves.toEqual([address.runId]);
    expect(cancelRun).toHaveBeenCalledOnce();
  });

  it("doesn't wait for a resumable task's run, which a cancel keeps", async () => {
    vi.mocked(getRun).mockReturnValue({ status: Promise.resolve("running") } as ReturnType<
      typeof getRun
    >);

    await expect(stopRuns([{ ends: false, run: address }], cancel)).resolves.toEqual([]);

    expect(resumeHook).toHaveBeenCalledOnce();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("cancels by run ID before the control hook is registered", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError(address.hookToken));

    await stopRuns([{ ends: true, run: address }], cancel);

    expect(cancelRun).toHaveBeenCalledWith(world, address.runId, { cancelReason: reason });
    expect(logError).not.toHaveBeenCalled();
  });

  it("ignores a run that finishes before the cancellation fallback", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError(address.hookToken));
    vi.mocked(cancelRun).mockRejectedValue(new EntityConflictError("Run already completed"));

    await expect(stopRuns([{ ends: true, run: address }], cancel)).resolves.toEqual([]);

    expect(cancelRun).toHaveBeenCalledOnce();
    expect(logError).not.toHaveBeenCalled();
  });

  it("falls back on delivery errors and logs an unsuccessful cancellation", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new Error("hook delivery unavailable"));
    vi.mocked(cancelRun).mockRejectedValue(new Error("run cancellation unavailable"));

    await expect(stopRuns([{ ends: true, run: address }], cancel)).resolves.toEqual([]);

    expect(cancelRun).toHaveBeenCalledWith(world, address.runId, { cancelReason: reason });
    expect(logError).toHaveBeenCalledTimes(2);
  });
});
