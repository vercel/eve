import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatTaskNotification,
  projectTaskActivitySettlement,
  projectTaskUpdateActivity,
} from "#execution/tasks/child/steps.js";
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

describe("projectTaskActivitySettlement", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("projects terminal task settlement", () => {
    expect(
      projectTaskActivitySettlement({
        activityObserver: {
          sink: {
            url: "https://parent.example/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
            version: 1,
          },
          workIdentity: {
            id: "work:task",
            kind: "task",
            rootSessionId: "root",
            rootTurnId: "turn",
          },
        },
        settledAt: "2026-01-01T00:00:00.000Z",
        view: notificationCases[0]!.view,
      }),
    ).toEqual([
      expect.objectContaining({ kind: "work.settled", outcome: "completed", workId: "work:task" }),
    ]);
  });

  it("projects an existing task update as a work milestone", () => {
    const working = { metadata, status: "working", taskId: "task-1" } satisfies TaskView;
    const input = {
      activityObserver: {
        sink: {
          url: "https://parent.example/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
          version: 1 as const,
        },
        workIdentity: {
          id: "work:task",
          kind: "task" as const,
          name: "reviewer",
          rootSessionId: "root",
          rootTurnId: "turn",
        },
      },
      update: {
        callId: "call-update",
        kind: "task-update" as const,
        message: "Comparing the plan projection with the current renderer",
        updateEpoch: "epoch-1",
        updateIndex: 2,
      },
      updatedAt: "2026-01-01T00:00:01.000Z",
      view: working,
    };

    expect(projectTaskUpdateActivity(input)).toEqual([
      {
        eventId: "work:task:updated:epoch-1:2",
        kind: "work.updated",
        message: "Comparing the plan projection with the current renderer",
        updatedAt: "2026-01-01T00:00:01.000Z",
        workId: "work:task",
      },
    ]);
    expect(
      projectTaskUpdateActivity({
        ...input,
        view: { ...working, lastOutput: { data: "done", type: "result" }, status: "completed" },
      }),
    ).toEqual([]);
  });

  it("does nothing for nonterminal task views", () => {
    expect(
      projectTaskActivitySettlement({
        activityObserver: undefined,
        settledAt: "2026-01-01T00:00:00.000Z",
        view: { metadata, status: "working", taskId: "task-1" },
      }),
    ).toEqual([]);
  });
});

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
