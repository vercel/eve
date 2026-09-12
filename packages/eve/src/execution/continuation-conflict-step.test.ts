import { beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";

const cancelRunMock = vi.fn();
const getWorldMock = vi.fn();
const world = {};
const resumeSessionInboxMock = vi.fn();

vi.mock("#execution/session-inbox/resume.js", () => ({
  resumeSessionInbox: (...args: unknown[]) => resumeSessionInboxMock(...args),
}));

vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun: (...args: unknown[]) => cancelRunMock(...args),
  getWorld: (...args: unknown[]) => getWorldMock(...args),
}));

const command = {
  auth: null,
  kind: "send" as const,
  payload: { message: "preserve me" },
  requestId: "request-1",
};

describe("settleContinuationConflictStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorldMock.mockResolvedValue(world);
    resumeSessionInboxMock.mockResolvedValue({ runId: "wrun_owner" });
    cancelRunMock.mockResolvedValue(undefined);
  });

  it("forwards a losing channel delivery and retires its activity collector", async () => {
    await settleContinuationConflictStep({
      activityCollectorRunId: "wrun_collector",
      command,
      continuationToken: "slack:C1:T1",
    });

    expect(resumeSessionInboxMock).toHaveBeenCalledWith("slack:C1:T1", command);
    expect(cancelRunMock).toHaveBeenCalledWith(world, "wrun_collector", {
      cancelReason: "Session candidate did not acquire continuation ownership",
    });
  });

  it("surfaces a vanished alias and still retires the losing collector", async () => {
    const error = new HookNotFoundError("slack:C1:T1");
    resumeSessionInboxMock.mockRejectedValue(error);
    await expect(
      settleContinuationConflictStep({
        activityCollectorRunId: "wrun_collector",
        command,
        continuationToken: "slack:C1:T1",
      }),
    ).rejects.toBe(error);
    expect(resumeSessionInboxMock).toHaveBeenCalledExactlyOnceWith("slack:C1:T1", command);
    expect(cancelRunMock).toHaveBeenCalledOnce();
  });
});
