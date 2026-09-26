import { HookNotFoundError, RunExpiredError } from "#compiled/@workflow/errors/index.js";
import { formatTaskNotification } from "#tasks/notification.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emitTaskActivityStep,
  deliverTaskInputResponsesStep,
  projectTaskActivity,
  notifyTaskParent,
} from "#execution/tasks/child/notify.js";
import { resumeWorkflowToolRunAnswers } from "#execution/tools/workflow/answer.js";
import type { TaskView } from "#tasks/types.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { submitActivity } from "#execution/submit-activity.js";

vi.mock("#execution/submit-activity.js", () => ({ submitActivity: vi.fn() }));

vi.mock("#execution/session-inbox/resume.js", () => ({ resumeSessionInbox: vi.fn() }));
vi.mock("#execution/tools/workflow/answer.js", () => ({
  resumeWorkflowToolRunAnswers: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const metadata = {
  kind: "tool" as const,
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

describe("emitTaskActivityStep", () => {
  it("waits for best-effort activity submission before the step finishes", async () => {
    const submission = Promise.withResolvers<void>();
    const submitted = Promise.withResolvers<void>();
    vi.mocked(submitActivity).mockImplementation(() => {
      submitted.resolve();
      return submission.promise;
    });
    let finished = false;
    const appended = emitTaskActivityStep({ view: notificationCases[0]!.view }).then(() => {
      finished = true;
    });
    await submitted.promise;
    await Promise.resolve();
    expect(finished).toBe(false);
    submission.resolve();
    await appended;
    expect(finished).toBe(true);
  });
});

describe("projectTaskActivity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("projects terminal task settlement", () => {
    expect(
      projectTaskActivity({
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

  it("projects task work when execution starts", () => {
    const workIdentity = {
      id: "work:task",
      kind: "task" as const,
      name: "export",
      parentId: "work:root",
      rootSessionId: "root",
      rootTurnId: "turn",
    };
    expect(
      projectTaskActivity({
        activityObserver: {
          sink: {
            url: "https://parent.example/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
            version: 1,
          },
          workIdentity,
        },
        settledAt: "2026-01-01T00:00:00.000Z",
        view: { metadata, status: "working", taskId: "task-1" },
      }),
    ).toEqual([
      {
        eventId: "work:task:started",
        kind: "work.started",
        startedAt: "2026-01-01T00:00:00.000Z",
        work: workIdentity,
      },
    ]);
  });

  it("does nothing without activity observation", () => {
    expect(
      projectTaskActivity({
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

describe("deliverTaskInputResponsesStep", () => {
  const answer = {
    childContinuationToken: "eve:eve:op:0123456789abcdef0123456789abcdef",
    inputResponses: [
      { optionId: "approve", requestId: "req-1" },
      { requestId: "stale", text: "ignore" },
    ],
    kind: "input-response" as const,
    taskId: "task-1",
  };

  it("delivers a local child answer through the child session inbox", async () => {
    await expect(deliverTaskInputResponsesStep({ answer, requestIds: ["req-1"] })).resolves.toBe(
      "delivered",
    );

    expect(resumeSessionInbox).toHaveBeenCalledWith(answer.childContinuationToken, {
      auth: undefined,
      kind: "send",
      payload: { inputResponses: [{ optionId: "approve", requestId: "req-1" }] },
      taskDeliveryId: "task-1:req-1",
    });
  });

  it("uses the persisted child address after its continuation alias changes", async () => {
    const childSessionInbox = { sessionId: "original-child", version: 1 };
    await deliverTaskInputResponsesStep({
      answer: { ...answer, childSessionInbox },
      requestIds: ["req-1"],
    });

    expect(resumeSessionInbox).toHaveBeenCalledWith(
      childSessionInbox,
      expect.objectContaining({
        payload: { inputResponses: [{ optionId: "approve", requestId: "req-1" }] },
      }),
    );
  });

  it("posts a remote child answer to its narrowed task-input route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const remoteAnswer = {
      ...answer,
      childResponseUrl: "https://remote.example/eve/v1/task-input/eve%3Atask-input%3Atoken",
    };

    await expect(
      deliverTaskInputResponsesStep({ answer: remoteAnswer, requestIds: ["req-1"] }),
    ).resolves.toBe("delivered");

    expect(fetchMock).toHaveBeenCalledWith(remoteAnswer.childResponseUrl, {
      body: JSON.stringify({ inputResponses: [{ optionId: "approve", requestId: "req-1" }] }),
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "error",
    });
    expect(resumeSessionInbox).not.toHaveBeenCalled();
  });

  it("keeps the task blocked when a remote child no longer has a pending input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    await expect(
      deliverTaskInputResponsesStep({
        answer: { ...answer, childResponseUrl: "https://remote.example/eve/v1/task-input/token" },
        requestIds: ["req-1"],
      }),
    ).resolves.toBe("unreachable");
  });

  it("resumes a workflow tool's private answer hook directly", async () => {
    const workflowToolRunAnswer = {
      ...answer,
      childContinuationToken: "eve:workflow-tool-run-answer:run-1:0",
    };

    await expect(
      deliverTaskInputResponsesStep({
        answer: workflowToolRunAnswer,
        answerHook: { runId: "run-1" },
        requestIds: ["req-1"],
      }),
    ).resolves.toBe("delivered");

    expect(resumeWorkflowToolRunAnswers).toHaveBeenCalledWith(
      "eve:workflow-tool-run-answer:run-1:0",
      [{ optionId: "approve", requestId: "req-1" }],
    );
  });
});

describe("notifyTaskParent", () => {
  it("deduplicates replays without collapsing input sources in the same step", async () => {
    for (const [replyTo, inputSource] of [
      ["remote", "alice"],
      ["remote", "bob"],
      ["remote", "alice"],
      ["other", "alice"],
    ]) {
      await notifyTaskParent({
        token: "parent-token",
        taskId: "task-1",
        request: {
          from: {
            callId: "call-1",
            execution: "background",
            input: {},
            runId: "run-1",
            sequence: 0,
            stepIndex: 0,
            toolName: "worker",
            turnId: "turn-1",
          },
          replyTo: replyTo!,
          inputSource,
          request: { kind: "ask", request: { prompt: "Approval word?" } },
        },
      });
    }
    const ids = vi
      .mocked(resumeSessionInbox)
      .mock.calls.map(([, command]) =>
        command.kind === "send" ? command.taskDeliveryId : undefined,
      );
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[2]);
    expect(new Set(ids).size).toBe(3);
  });

  it("forwards an agent invocation through the typed task envelope", async () => {
    const request = {
      from: {
        callId: "call-1",
        execution: "background" as const,
        input: {},
        runId: "run-1",
        sequence: 0,
        stepIndex: 0,
        toolName: "research",
        turnId: "turn-1",
      },
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", target: "research" },
        invocationId: "call-1:research",
        kind: "agent-invoke" as const,
      },
    };

    await notifyTaskParent({ request, taskId: "task-1", token: "parent-token" });

    expect(resumeSessionInbox).toHaveBeenCalledWith("parent-token", {
      kind: "send",
      payload: {
        task: {
          agentRequests: [
            {
              replyTo: "agent-reply",
              request: {
                input: { message: "Find it", target: "research" },
                invocationId: "call-1:research",
                kind: "agent-invoke",
              },
              taskId: "task-1",
            },
          ],
        },
      },
      taskDeliveryId: "task-1:agent:run-1:call-1:research",
    });
  });
});

describe("notifyTaskParent", () => {
  const notification = {
    token: "parent-token",
    view: {
      taskId: "task-1",
      metadata,
      status: "completed" as const,
      lastOutput: { type: "result" as const, data: "done" },
    },
  };

  it("preserves the payload and deduplication identity", async () => {
    await notifyTaskParent(notification);
    expect(resumeSessionInbox).toHaveBeenCalledExactlyOnceWith(notification.token, {
      kind: "send",
      payload: {
        message: "Background task task-1 (reviewer) is completed.\n\nResult:\ndone",
        task: { views: [notification.view] },
      },
      taskDeliveryId: "task-1:ready:completed",
    });
  });

  it.each([
    new HookNotFoundError("parent-token"),
    new Error("delivery failed", { cause: new RunExpiredError("parent ended") }),
  ])("tolerates an ended parent", async (error) => {
    vi.mocked(resumeSessionInbox).mockRejectedValueOnce(error);
    await expect(notifyTaskParent(notification)).resolves.toBeUndefined();
  });

  it("propagates transient delivery failures so the durable step can retry", async () => {
    const error = new Error("storage unavailable");
    vi.mocked(resumeSessionInbox).mockRejectedValueOnce(error);
    await expect(notifyTaskParent(notification)).rejects.toBe(error);
  });
});
