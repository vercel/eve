import { beforeEach, describe, expect, it, vi } from "vitest";

import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import { sendTaskCommandToOwner } from "#execution/tasks/parent/run-parent.js";

vi.mock("#execution/tasks/parent/run-parent.js", () => ({
  readLatestTaskView: vi.fn(),
  sendTaskCommandToOwner: vi.fn(),
}));

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
});
