import { afterEach, describe, expect, it, vi } from "vitest";
import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import {
  appendTaskViewStep,
  deliverTaskInputResponsesStep,
  wakeTaskAuthorizationParentStep,
  wakeTaskInputRequestParentStep,
  wakeTaskParentStep,
  wakeTaskUpdateParentStep,
} from "#execution/tasks/child/steps.js";
import { taskRunWorkflow } from "#execution/tasks/child/workflow.js";
import type {
  TaskCommandHookPayload,
  TaskInboundAnswerInput,
  TaskRunInboundPayload,
  TaskView,
} from "#tasks/types.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: vi.fn(),
}));

vi.mock("#execution/hook-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/hook-ownership.js")>()),
  claimHookOwnership: vi.fn(),
  disposeHook: vi.fn(),
}));

vi.mock("#execution/tasks/child/steps.js", () => ({
  appendTaskViewStep: vi.fn(),
  deliverTaskInputResponsesStep: vi.fn(),
  wakeTaskAuthorizationParentStep: vi.fn(),
  wakeTaskInputRequestParentStep: vi.fn(),
  wakeTaskParentStep: vi.fn(),
  wakeTaskUpdateParentStep: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

const activityObserver = {
  sink: {
    url: "https://parent.example/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
    version: 1 as const,
  },
  workIdentity: {
    id: "work:task",
    kind: "task" as const,
    name: "research",
    rootSessionId: "root",
    rootTurnId: "turn",
  },
};

function createWorkingView(): TaskView {
  return {
    metadata: {
      agentId: "ag_research:abcdef123456",
      kind: "subagent",
      mode: "local",
      name: "research",
    },
    status: "working",
    taskId: "task_abc123",
  };
}

function mockCommandHook(
  payloads: readonly (TaskRunInboundPayload | SubagentAuthorizationEventHookPayload)[],
): void {
  const queue = [...payloads];
  const hook = {
    [Symbol.asyncIterator]: () => ({
      next: async () =>
        queue.length > 0
          ? { done: false as const, value: queue.shift() as TaskCommandHookPayload }
          : { done: true as const, value: undefined },
    }),
    token: "task-token",
  } as Hook<TaskRunInboundPayload | SubagentAuthorizationEventHookPayload>;
  vi.mocked(createHook).mockReturnValue(hook);
}

function appendedStatuses(): readonly string[] {
  return vi.mocked(appendTaskViewStep).mock.calls.map(([input]) => input.view.status);
}

describe("taskRunWorkflow", () => {
  it("forwards child updates after dispatch acknowledgement without changing the view", async () => {
    const update = {
      callId: "update-call",
      updateIndex: 2,
      updateEpoch: "turn-child",
      kind: "task-update" as const,
      message: "Found three matching records.",
    };
    mockCommandHook([
      update,
      { command: { kind: "ready" }, kind: "task-command" },
      { ...update, callId: "update-call-2" },
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    const view = createWorkingView();
    await taskRunWorkflow({
      activityObserver,
      taskInboxToken: "task-token",
      initialView: view,
      parentContinuationToken: "parent-session-token",
    });

    expect(wakeTaskUpdateParentStep).toHaveBeenNthCalledWith(1, {
      activityObserver,
      token: "parent-session-token",
      update,
      view,
    });
    expect(wakeTaskUpdateParentStep).toHaveBeenNthCalledWith(2, {
      activityObserver,
      token: "parent-session-token",
      update: { ...update, callId: "update-call-2" },
      view,
    });
    expect(appendedStatuses()).toEqual(["working", "working", "completed"]);
  });

  it("forwards a fast child update before its terminal wake", async () => {
    const update = {
      callId: "update-call",
      updateIndex: 2,
      updateEpoch: "turn-child",
      kind: "task-update" as const,
      message: "Final progress update.",
    };
    mockCommandHook([
      update,
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
      { command: { kind: "ready" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(wakeTaskUpdateParentStep).toHaveBeenCalledWith({
      token: "parent-session-token",
      update,
      view: expect.objectContaining({ status: "completed" }),
    });
    expect(wakeTaskParentStep).toHaveBeenCalledWith({
      token: "parent-session-token",
      view: expect.objectContaining({ status: "completed" }),
    });
    expect(vi.mocked(wakeTaskUpdateParentStep).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(wakeTaskParentStep).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("publishes the initial view, applies commands, and stops at terminal", async () => {
    mockCommandHook([
      { command: { kind: "ready" }, kind: "task-command" },
      {
        command: {
          inputRequests: [{ question: "which?", requestId: "req-1" }],
          kind: "require-input",
        },
        kind: "task-command",
      },
      { command: { kind: "answered", requestIds: ["req-1"] }, kind: "task-command" },
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
      // Never consumed: the run stops at the terminal transition.
      { command: { kind: "cancel" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual([
      "working",
      "working",
      "input_required",
      "working",
      "completed",
    ]);
    expect(disposeHook).toHaveBeenCalledTimes(1);
  });

  it("skips views for rejected and noop commands", async () => {
    mockCommandHook([
      { command: { kind: "answered", requestIds: ["req-1"] }, kind: "task-command" }, // noop on working
      { command: { kind: "cancel" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working", "cancelled"]);
  });

  it("exits without touching the lifecycle when the hook claim conflicts", async () => {
    mockCommandHook([]);
    vi.mocked(claimHookOwnership).mockRejectedValue(
      Object.assign(new Error("Hook token in use"), { name: "HookConflictError" }),
    );

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(appendTaskViewStep).not.toHaveBeenCalled();
    expect(disposeHook).not.toHaveBeenCalled();
  });

  it("disposes its hook when the command stream closes early", async () => {
    mockCommandHook([
      { command: { inputRequests: [], kind: "require-input" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working"]);
    expect(disposeHook).toHaveBeenCalledTimes(1);
  });

  it("translates a settled child turn from the wire and wakes the parent once ready", async () => {
    const ZERO = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };
    mockCommandHook([
      { command: { kind: "ready" }, kind: "task-command" },
      {
        kind: "runtime-action-result",
        results: [
          {
            outcome: {
              kind: "parked",
              result: { kind: "succeeded", output: "answer" },
              usageDelta: ZERO,
            },
            output: "answer",
          },
        ],
      },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: {
        ...createWorkingView(),
        metadata: {
          agentId: "ag_research:abcdef123456",
          kind: "subagent",
          mode: "local",
          name: "research",
        },
      },
      parentContinuationToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working", "working", "completed"]);
    expect(wakeTaskParentStep).toHaveBeenCalledTimes(1);
    expect(vi.mocked(wakeTaskParentStep).mock.calls[0]?.[0]).toMatchObject({
      token: "parent-session-token",
      view: { status: "completed", taskId: "task_abc123" },
    });
  });

  it("keeps a fast terminal task hook alive until dispatch acknowledgement", async () => {
    mockCommandHook([
      {
        kind: "runtime-action-result",
        results: [
          {
            outcome: {
              kind: "parked",
              result: { kind: "succeeded", output: "fast" },
            },
            output: "fast",
          },
        ],
      },
      { command: { kind: "ready" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working", "completed"]);
    expect(wakeTaskParentStep).toHaveBeenCalledTimes(1);
    expect(disposeHook).toHaveBeenCalledTimes(1);
  });

  it("silently terminates a dispatch rejected before parent indexing", async () => {
    mockCommandHook([
      {
        command: { data: { code: "START_FAILED" }, kind: "reject-dispatch" },
        kind: "task-command",
      },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working", "failed"]);
    expect(wakeTaskParentStep).not.toHaveBeenCalled();
    expect(disposeHook).toHaveBeenCalledTimes(1);
  });

  it("releases a fast input request when the readiness barrier arrives", async () => {
    mockCommandHook([
      {
        callId: "call-task",
        childContinuationToken: "child-token",
        childSessionId: "child-session",
        event: {
          requests: [
            {
              action: { callId: "call-q", input: {}, kind: "tool-call", toolName: "ask" },
              kind: "question",
              prompt: "Which?",
              requestId: "q1",
            },
          ],
          sequence: 1,
          stepIndex: 2,
          turnId: "turn-child",
        },
        kind: "subagent-input-request",
        subagentName: "research",
      },
      { command: { kind: "ready" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(wakeTaskInputRequestParentStep).toHaveBeenCalledTimes(1);
    expect(wakeTaskParentStep).not.toHaveBeenCalled();
  });

  it("normalizes and holds a local authorization event until the readiness barrier", async () => {
    mockCommandHook([
      {
        callId: "call-task",
        childSessionId: "child-session",
        event: {
          data: {
            attemptId: "github-1",
            description: "Authorize GitHub",
            name: "github",
            sequence: 1,
            stepIndex: 2,
            turnId: "turn-child",
          },
          type: "authorization.required",
        },
        kind: "subagent-authorization-event",
        subagentName: "research",
      },
      {
        callId: "call-task",
        childSessionId: "child-session",
        event: {
          data: {
            attemptId: "linear-1",
            description: "Authorize Linear",
            name: "linear",
            sequence: 1,
            stepIndex: 2,
            turnId: "turn-child",
          },
          type: "authorization.required",
        },
        kind: "subagent-authorization-event",
        subagentName: "research",
      },
      { command: { kind: "ready" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual([
      "working",
      "input_required",
      "input_required",
      "input_required",
    ]);
    expect(wakeTaskAuthorizationParentStep).toHaveBeenCalledTimes(2);
    expect(wakeTaskAuthorizationParentStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        request: expect.objectContaining({
          event: expect.objectContaining({
            data: expect.objectContaining({ name: "github" }),
          }),
        }),
      }),
    );
    expect(wakeTaskAuthorizationParentStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: expect.objectContaining({
          event: expect.objectContaining({
            data: expect.objectContaining({ name: "linear" }),
          }),
        }),
      }),
    );
    expect(vi.mocked(wakeTaskAuthorizationParentStep).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(appendTaskViewStep).mock.invocationCallOrder[2] ?? 0,
    );
  });

  it("ignores approval lifecycle events and still wakes on terminal settlement", async () => {
    mockCommandHook([
      { command: { kind: "ready" }, kind: "task-command" },
      {
        callId: "call-task",
        childSessionId: "child-session-1",
        event: {
          data: {
            outcome: "approved",
            requestId: "stale-1",
            responderPrincipalId: "user-1",
            sequence: 1,
            stepIndex: 2,
            turnId: "turn-child",
          },
          type: "approval.settled",
        },
        kind: "subagent-authorization-event",
        subagentName: "research",
      },
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(wakeTaskAuthorizationParentStep).not.toHaveBeenCalled();
    expect(wakeTaskParentStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ view: expect.objectContaining({ status: "completed" }) }),
    );
  });

  it("never wakes twice for one blocked child", async () => {
    mockCommandHook([
      { command: { kind: "ready" }, kind: "task-command" },
      {
        command: { inputRequests: [{ q: 1, requestId: "q1" }], kind: "require-input" },
        kind: "task-command",
      },
      {
        command: { inputRequests: [{ q: 2, requestId: "q2" }], kind: "require-input" },
        kind: "task-command",
      },
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    // input_required wakes once; the second require-input replaces the
    // batch without leaving the ready state, while terminal settlement
    // still wakes independently after direct HITL responses.
    expect(wakeTaskParentStep).toHaveBeenCalledTimes(2);
  });

  it("commits and forwards every exact local task HITL batch before terminal wake", async () => {
    const request = (requestId: string) => ({
      action: {
        callId: `call-${requestId}`,
        input: {},
        kind: "tool-call" as const,
        toolName: "ask",
      },
      kind: "question" as const,
      prompt: requestId,
      requestId,
    });
    const inbound = (requestId: string): TaskRunInboundPayload => ({
      callId: "call-task",
      childContinuationToken: "child-token",
      childSessionId: "child-session-1",
      event: { requests: [request(requestId)], sequence: 1, stepIndex: 2, turnId: "turn_child" },
      kind: "subagent-input-request",
      subagentName: "research",
    });
    mockCommandHook([
      { command: { kind: "ready" }, kind: "task-command" },
      inbound("q1"),
      inbound("q2"),
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(wakeTaskInputRequestParentStep).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(wakeTaskInputRequestParentStep).mock.calls.map(([input]) => {
        const request = input.request.event.requests[0];
        return request !== null && typeof request === "object"
          ? Reflect.get(request, "requestId")
          : undefined;
      }),
    ).toEqual(["q1", "q2"]);
    expect(wakeTaskParentStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ view: expect.objectContaining({ status: "completed" }) }),
    );
    const firstInputWakeOrder =
      vi.mocked(wakeTaskInputRequestParentStep).mock.invocationCallOrder[0] ?? 0;
    const firstInputAppendOrder = vi.mocked(appendTaskViewStep).mock.invocationCallOrder[2] ?? 0;
    expect(firstInputAppendOrder).toBeLessThan(firstInputWakeOrder);
  });
});

describe("taskRunWorkflow answered input", () => {
  function requireInput(...requestIds: readonly string[]): TaskRunInboundPayload {
    return {
      command: {
        inputRequests: requestIds.map((requestId) => ({ prompt: requestId, requestId })),
        kind: "require-input",
      },
      kind: "task-command",
    };
  }

  function answer(...requestIds: readonly string[]): TaskInboundAnswerInput {
    return {
      childContinuationToken: "child-token",
      inputResponses: requestIds.map((requestId) => ({ requestId, text: "answer" })),
      kind: "input-response",
      taskId: "task_abc123",
    };
  }

  it("forwards the answer to the child before recording it as unblocked", async () => {
    vi.mocked(deliverTaskInputResponsesStep).mockResolvedValue("delivered");
    mockCommandHook([
      requireInput("q1"),
      answer("q1"),
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(deliverTaskInputResponsesStep).toHaveBeenCalledWith({
      answer: answer("q1"),
      requestIds: ["q1"],
    });
    expect(appendedStatuses()).toEqual(["working", "input_required", "working", "completed"]);
    const deliveryOrder = vi.mocked(deliverTaskInputResponsesStep).mock.invocationCallOrder[0] ?? 0;
    const unblockOrder = vi.mocked(appendTaskViewStep).mock.invocationCallOrder[2] ?? 0;
    expect(deliveryOrder).toBeLessThan(unblockOrder);
  });

  it("never lets an answer to a superseded batch reach the child", async () => {
    vi.mocked(deliverTaskInputResponsesStep).mockResolvedValue("delivered");
    mockCommandHook([
      requireInput("q1"),
      requireInput("q2"),
      answer("q1"),
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(deliverTaskInputResponsesStep).not.toHaveBeenCalled();
    expect(appendedStatuses()).toEqual([
      "working",
      "input_required",
      "input_required",
      "completed",
    ]);
  });

  it("stays blocked on the requests an answer did not cover", async () => {
    vi.mocked(deliverTaskInputResponsesStep).mockResolvedValue("delivered");
    mockCommandHook([
      requireInput("q1", "q2"),
      answer("q1", "unknown"),
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(deliverTaskInputResponsesStep).toHaveBeenCalledWith({
      answer: answer("q1", "unknown"),
      requestIds: ["q1"],
    });
    const blockedAgain = vi.mocked(appendTaskViewStep).mock.calls[2]?.[0].view;
    expect(blockedAgain?.status).toBe("input_required");
    expect(blockedAgain?.inputRequests).toEqual([{ prompt: "q2", requestId: "q2" }]);
  });

  it("keeps the task blocked when the child never received the answer", async () => {
    vi.mocked(deliverTaskInputResponsesStep).mockResolvedValue("unreachable");
    mockCommandHook([
      requireInput("q1"),
      answer("q1"),
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working", "input_required", "completed"]);
  });

  it("ignores an answer addressed to a different task", async () => {
    vi.mocked(deliverTaskInputResponsesStep).mockResolvedValue("delivered");
    mockCommandHook([
      requireInput("q1"),
      { ...answer("q1"), taskId: "task_other" },
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      taskInboxToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-session-token",
    });

    expect(deliverTaskInputResponsesStep).not.toHaveBeenCalled();
    expect(appendedStatuses()).toEqual(["working", "input_required", "completed"]);
  });
});
