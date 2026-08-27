import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  wakeTaskParentStep,
  wakeTaskUpdateParentStep,
  wakeTaskViewParentStep,
} from "#execution/tasks/child/steps.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import type { TaskView } from "#tasks/types.js";

vi.mock("#execution/wire/session-inbox-resume.js", () => ({
  resumeSessionInbox: vi.fn(),
}));

const view = {
  metadata: {
    agentId: "agent_1",
    kind: "subagent" as const,
    mode: "local" as const,
    name: "research",
  },
  status: "working" as const,
  taskId: "task_1",
} satisfies TaskView;

describe("task client deliveries", () => {
  beforeEach(() => vi.resetAllMocks());

  it("publishes the initial view without a model message", async () => {
    await wakeTaskViewParentStep({ index: 0, token: "parent-token", view });

    expect(resumeSessionInbox).toHaveBeenCalledExactlyOnceWith("parent-token", {
      kind: "send",
      payload: { task: { views: [view] } },
      taskDeliveryId: "task_1:client:0",
    });
  });

  it("publishes child activity with the current view", async () => {
    await wakeTaskUpdateParentStep({
      token: "parent-token",
      update: {
        callId: "call_1",
        kind: "task-update",
        message: "Checking inventory.",
        updateEpoch: "turn_1",
        updateIndex: 1,
      },
      view,
    });

    expect(resumeSessionInbox).toHaveBeenCalledWith(
      "parent-token",
      expect.objectContaining({
        payload: {
          message: "Background task task_1 (research) update: Checking inventory.",
          task: { views: [view] },
        },
      }),
    );
  });

  it("publishes terminal task state with its framework notification", async () => {
    const completed = {
      ...view,
      lastOutput: { data: "Found it.", type: "result" as const },
      status: "completed" as const,
    } satisfies TaskView;

    await wakeTaskParentStep({ token: "parent-token", view: completed });

    expect(resumeSessionInbox).toHaveBeenCalledWith(
      "parent-token",
      expect.objectContaining({
        payload: {
          message: "Background task task_1 (research) is completed.\n\nResult:\nFound it.",
        },
      }),
    );
  });
});
