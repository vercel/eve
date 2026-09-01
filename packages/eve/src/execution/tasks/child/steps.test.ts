import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deliverTaskInputResponsesStep,
  formatTaskNotification,
  wakeTaskEffectParentStep,
} from "#execution/tasks/child/steps.js";
import { resumeWorkflowToolRunAnswers } from "#execution/tools/workflow/answer.js";
import type { TaskView } from "#tasks/types.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";

vi.mock("#execution/wire/session-inbox-resume.js", () => ({ resumeSessionInbox: vi.fn() }));
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

describe("wakeTaskEffectParentStep", () => {
  it("forwards an agent invocation through the task effect envelope", async () => {
    const request = {
      from: {
        callId: "call-1",
        execution: "background" as const,
        input: {},
        runId: "run-1",
        stepIndex: 0,
        toolName: "research",
        turnId: "turn-1",
      },
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", target: "research" },
        invocationId: "call-1:research",
        kind: "effect" as const,
        name: "workflow.event",
      },
    };

    await wakeTaskEffectParentStep({ request, taskId: "task-1", token: "parent-token" });

    expect(resumeSessionInbox).toHaveBeenCalledWith("parent-token", {
      kind: "send",
      payload: {
        task: {
          effects: [
            {
              input: { message: "Find it", target: "research" },
              invocationId: "call-1:research",
              name: "workflow.event",
              replyTo: "agent-reply",
              taskId: "task-1",
            },
          ],
        },
      },
      taskDeliveryId: "task-1:effect:run-1:call-1:research",
    });
  });
});
