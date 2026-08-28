import { describe, expect, it } from "vitest";

import { formatTaskNotification } from "#execution/tasks/child/steps.js";
import type { TaskView } from "#tasks/types.js";

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

describe("formatTaskNotification", () => {
  it.each(notificationCases)(
    "includes terminal output in the parent notification",
    ({ expected, view }) => {
      expect(formatTaskNotification(view)).toBe(expected);
    },
  );

  it("reports cancellation without inventing output", () => {
    const view = {
      metadata,
      status: "cancelled",
      taskId: "task-1",
    } satisfies TaskView;

    expect(formatTaskNotification(view)).toBe("Background task task-1 (reviewer) is cancelled.");
  });
});
