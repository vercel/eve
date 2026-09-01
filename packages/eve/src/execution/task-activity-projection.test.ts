import { describe, expect, it } from "vitest";

import { projectTaskActivity } from "#execution/task-activity-projection.js";
import type { TaskView } from "#tasks/types.js";

const metadata = {
  agentId: "agent-reviewer",
  kind: "subagent" as const,
  mode: "local" as const,
  name: "reviewer",
};

function view(status: TaskView["status"]): TaskView {
  if (status === "completed") {
    return {
      lastOutput: { data: "done", type: "result" },
      metadata,
      status,
      taskId: "task-1",
    };
  }
  if (status === "failed") {
    return {
      lastOutput: { data: "failed", type: "error" },
      metadata,
      status,
      taskId: "task-1",
    };
  }
  if (status === "input_required") {
    return { inputRequests: [], metadata, status, taskId: "task-1" };
  }
  return { metadata, status, taskId: "task-1" };
}

const activityObserver = {
  sink: {
    url: "https://parent.example/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
    version: 1 as const,
  },
  workIdentity: {
    id: "work:task",
    kind: "task" as const,
    rootSessionId: "root",
    rootTurnId: "turn",
  },
};

describe("projectTaskActivity", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "projects authoritative %s task settlement",
    (status) => {
      expect(
        projectTaskActivity({
          activityObserver,
          settledAt: "2026-01-01T00:00:00.000Z",
          view: view(status),
        }),
      ).toEqual([
        {
          eventId: "work:task:started",
          kind: "work.started",
          startedAt: "2026-01-01T00:00:00.000Z",
          work: activityObserver.workIdentity,
        },
        {
          eventId: `work:task:settled:${status}`,
          kind: "work.settled",
          outcome: status,
          settledAt: "2026-01-01T00:00:00.000Z",
          workId: "work:task",
        },
      ]);
    },
  );

  it("starts work from the initial task view", () => {
    expect(
      projectTaskActivity({
        activityObserver,
        settledAt: "2026-01-01T00:00:00.000Z",
        view: view("working"),
      }),
    ).toEqual([
      {
        eventId: "work:task:started",
        kind: "work.started",
        startedAt: "2026-01-01T00:00:00.000Z",
        work: activityObserver.workIdentity,
      },
    ]);
  });
});
