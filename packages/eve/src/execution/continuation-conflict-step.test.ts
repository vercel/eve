import { beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";

const cancelRunMock = vi.fn();
const getWorldMock = vi.fn();
const resumeSessionInboxMock = vi.fn();

vi.mock("#execution/wire/session-inbox-resume.js", () => ({
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
};

describe("settleContinuationConflictStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorldMock.mockResolvedValue("world");
    resumeSessionInboxMock.mockResolvedValue({ runId: "wrun_owner" });
    cancelRunMock.mockResolvedValue(undefined);
  });

  it("forwards a losing channel delivery and retires its activity collector", async () => {
    await settleContinuationConflictStep({
      activityCollectorRunId: "wrun_collector",
      command,
      continuationToken: "slack:C1:T1",
      ownerSessionId: "wrun_owner",
    });

    expect(resumeSessionInboxMock).toHaveBeenCalledWith("slack:C1:T1", command);
    expect(cancelRunMock).toHaveBeenCalledWith("world", "wrun_collector", {
      cancelReason: "Session candidate did not acquire continuation ownership",
    });
  });

  it("falls back to the winner's stable inbox after the alias is re-keyed", async () => {
    resumeSessionInboxMock
      .mockRejectedValueOnce(new HookNotFoundError("slack:C1:T1"))
      .mockResolvedValueOnce({ runId: "wrun_owner" });

    await settleContinuationConflictStep({
      command,
      continuationToken: "slack:C1:T1",
      ownerSessionId: "wrun_owner",
    });

    expect(resumeSessionInboxMock).toHaveBeenNthCalledWith(1, "slack:C1:T1", command);
    expect(resumeSessionInboxMock).toHaveBeenNthCalledWith(
      2,
      sessionCommandHookToken("wrun_owner"),
      command,
    );
  });
});
