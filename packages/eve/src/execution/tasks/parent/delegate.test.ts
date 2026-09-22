import { beforeEach, describe, expect, it, vi } from "vitest";

import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import { sendTaskCommandToOwner } from "#execution/tasks/parent/run-parent.js";

vi.mock("#execution/tasks/parent/run-parent.js", () => ({
  sendTaskCommandToOwner: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ getRun: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => mocks);

describe("task readiness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sendTaskCommandToOwner).mockResolvedValue({ runId: "run-owner" });
  });

  it("acknowledges a generic background task after indexing", async () => {
    await acknowledgeDelegatedTasksStep({
      tasks: [{ taskId: "task-1", taskInboxToken: "task-token", taskRunId: "run-1" }],
    });
    expect(sendTaskCommandToOwner).toHaveBeenCalledWith(
      expect.objectContaining({ command: { kind: "ready" }, taskInboxToken: "task-token" }),
    );
  });
  it.each(["completed", "cancelled", "failed", "running"] as const)(
    "handles a missing readiness hook when the run is %s",
    async (status) => {
      vi.mocked(sendTaskCommandToOwner).mockResolvedValue(undefined);
      mocks.getRun.mockReturnValue({ status: Promise.resolve(status) });
      const ready = acknowledgeDelegatedTasksStep({
        tasks: [{ taskId: "task-1", taskInboxToken: "task-token", taskRunId: "run-1" }],
      });
      if (status === "completed" || status === "cancelled")
        await expect(ready).resolves.toBeUndefined();
      else await expect(ready).rejects.toThrow("did not accept its readiness command");
    },
  );
});
