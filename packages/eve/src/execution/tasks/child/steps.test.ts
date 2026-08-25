import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatTaskNotification,
  wakeTaskAuthorizationParentStep,
} from "#execution/tasks/child/steps.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import type { TaskInboundAuthorizationEvent, TaskView } from "#tasks/types.js";

vi.mock("#execution/wire/session-inbox-resume.js", () => ({
  resumeSessionInbox: vi.fn(),
}));

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

describe("wakeTaskAuthorizationParentStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses distinct delivery ids for candidate lifecycle transitions at one tool step", async () => {
    const request = {
      callId: "call-task",
      childSessionId: "child-session-1",
      event: {
        data: {
          candidateId: "candidate-1",
          outcome: "pending" as const,
          requestId: "approval-1",
          responderPrincipalId: "user-1",
          sequence: 1,
          stepIndex: 2,
          turnId: "turn-child",
        },
        type: "approval.candidate" as const,
      },
      kind: "authorization-event" as const,
      subagentName: "research",
    } satisfies TaskInboundAuthorizationEvent;

    await wakeTaskAuthorizationParentStep({
      request,
      taskId: "task-1",
      token: "parent-token",
    });
    await wakeTaskAuthorizationParentStep({
      request: {
        ...request,
        event: {
          ...request.event,
          data: { ...request.event.data, outcome: "rejected" },
        },
      },
      taskId: "task-1",
      token: "parent-token",
    });

    const deliveryIds = vi
      .mocked(resumeSessionInbox)
      .mock.calls.map(([, command]) =>
        "taskDeliveryId" in command ? command.taskDeliveryId : undefined,
      );
    expect(deliveryIds).toEqual([
      expect.stringMatching(/:candidate-1:pending$/),
      expect.stringMatching(/:candidate-1:rejected$/),
    ]);
  });
});
