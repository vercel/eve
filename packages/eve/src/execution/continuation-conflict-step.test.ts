import { beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";

const resumeSessionInboxMock = vi.fn();

vi.mock("#execution/session-inbox/resume.js", () => ({
  resumeSessionInbox: (...args: unknown[]) => resumeSessionInboxMock(...args),
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
    resumeSessionInboxMock.mockResolvedValue({ runId: "wrun_owner" });
  });

  it("forwards a losing candidate's payload to the continuation owner unchanged", async () => {
    await settleContinuationConflictStep({ continuationToken: "slack:C1:T1", payload: command });

    expect(resumeSessionInboxMock.mock.calls).toEqual([["slack:C1:T1", command]]);
  });

  it("surfaces a vanished alias", async () => {
    const error = new HookNotFoundError("slack:C1:T1");
    resumeSessionInboxMock.mockRejectedValue(error);

    await expect(
      settleContinuationConflictStep({ continuationToken: "slack:C1:T1", payload: command }),
    ).rejects.toBe(error);
  });
});
