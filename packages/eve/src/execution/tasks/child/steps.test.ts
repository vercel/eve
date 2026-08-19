import { beforeEach, describe, expect, it, vi } from "vitest";

import { wakeTaskParentStep } from "#execution/tasks/child/steps.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { TaskView } from "#tasks/types.js";

vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: vi.fn() }));

const metadata = {
  agentId: "agent-reviewer",
  kind: "subagent" as const,
  mode: "local" as const,
  name: "reviewer",
};

const notificationCases: readonly { readonly expected: string; readonly view: TaskView }[] = [
  {
    expected: "Background task task-1 (reviewer) is completed.\n\nResult:\nship it",
    view: {
      lastOutput: { data: "ship it", type: "result" },
      metadata,
      status: "completed",
      taskId: "task-1",
    },
  },
  {
    expected: 'Background task task-1 (reviewer) is completed.\n\nResult:\n{"verdict":"ship"}',
    view: {
      lastOutput: { data: { verdict: "ship" }, type: "result" },
      metadata,
      status: "completed",
      taskId: "task-1",
    },
  },
  {
    expected: 'Background task task-1 (reviewer) failed.\n\nError:\n{"code":"FAILED"}',
    view: {
      lastOutput: { data: { code: "FAILED" }, type: "error" },
      metadata,
      status: "failed",
      taskId: "task-1",
    },
  },
];

describe("wakeTaskParentStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resumeHook).mockResolvedValue({} as never);
  });

  it.each(notificationCases)(
    "includes terminal output in the parent notification",
    async ({ expected, view }) => {
      await wakeTaskParentStep({ token: "parent-token", view });

      expect(resumeHook).toHaveBeenCalledExactlyOnceWith(
        "parent-token",
        expect.objectContaining({
          payload: expect.objectContaining({ message: expected, task: { views: [view] } }),
        }),
      );
    },
  );

  it("reports cancellation without inventing output", async () => {
    const view = {
      metadata,
      status: "cancelled",
      taskId: "task-1",
    } satisfies TaskView;

    await wakeTaskParentStep({ token: "parent-token", view });

    expect(resumeHook).toHaveBeenCalledExactlyOnceWith(
      "parent-token",
      expect.objectContaining({
        payload: expect.objectContaining({
          message: "Background task task-1 (reviewer) is cancelled.",
        }),
      }),
    );
  });
});
