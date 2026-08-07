import { afterEach, describe, expect, it, vi } from "vitest";
import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import {
  appendTaskSnapshotStep,
  deliverTaskInputResponsesStep,
  wakeTaskAuthorizationParentStep,
  wakeTaskInputRequestParentStep,
  wakeTaskParentStep,
} from "#execution/tasks/run-steps.js";
import { taskRunWorkflow } from "#execution/tasks/run-workflow.js";
import type {
  TaskCommandHookPayload,
  TaskInboundAnswerInput,
  TaskRunInboundPayload,
  TaskView,
} from "#tasks/types.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: vi.fn(),
}));

vi.mock("../hook-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hook-ownership.js")>()),
  claimHookOwnership: vi.fn(),
  disposeHook: vi.fn(),
}));

vi.mock("./run-steps.js", () => ({
  appendTaskSnapshotStep: vi.fn(),
  deliverTaskInputResponsesStep: vi.fn(),
  wakeTaskAuthorizationParentStep: vi.fn(),
  wakeTaskInputRequestParentStep: vi.fn(),
  wakeTaskParentStep: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

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

function mockCommandHook(payloads: readonly TaskRunInboundPayload[]): void {
  const queue = [...payloads];
  const hook = {
    [Symbol.asyncIterator]: () => ({
      next: async () =>
        queue.length > 0
          ? { done: false as const, value: queue.shift() as TaskCommandHookPayload }
          : { done: true as const, value: undefined },
    }),
    token: "task-token",
  } as Hook<TaskRunInboundPayload>;
  vi.mocked(createHook).mockReturnValue(hook);
}

function appendedStatuses(): readonly string[] {
  return vi.mocked(appendTaskSnapshotStep).mock.calls.map(([input]) => input.view.status);
}

describe("taskRunWorkflow", () => {
  it("publishes the initial snapshot, applies commands, and stops at terminal", async () => {
    mockCommandHook([
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

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(appendedStatuses()).toEqual(["working", "input_required", "working", "completed"]);
    expect(disposeHook).toHaveBeenCalledTimes(1);
  });

  it("skips snapshots for rejected and noop commands", async () => {
    mockCommandHook([
      { command: { kind: "answered", requestIds: ["req-1"] }, kind: "task-command" }, // noop on working
      { command: { kind: "cancel" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(appendedStatuses()).toEqual(["working", "cancelled"]);
  });

  it("exits without touching the lifecycle when the hook claim conflicts", async () => {
    mockCommandHook([]);
    vi.mocked(claimHookOwnership).mockRejectedValue(
      Object.assign(new Error("Hook token in use"), { name: "HookConflictError" }),
    );

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(appendTaskSnapshotStep).not.toHaveBeenCalled();
    expect(disposeHook).not.toHaveBeenCalled();
  });

  it("disposes its hook when the command stream closes early", async () => {
    mockCommandHook([
      { command: { inputRequests: [], kind: "require-input" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(appendedStatuses()).toEqual(["working"]);
    expect(disposeHook).toHaveBeenCalledTimes(1);
  });

  it("translates a settled child turn from the wire and wakes the parent once ready", async () => {
    const ZERO = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };
    mockCommandHook([
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
      commandToken: "task-token",
      initialView: {
        ...createWorkingView(),
        metadata: {
          agentId: "ag_research:abcdef123456",
          kind: "subagent",
          mode: "local",
          name: "research",
        },
      },
      wakeToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working", "completed"]);
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
      commandToken: "task-token",
      initialView: createWorkingView(),
      wakeToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working", "completed"]);
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
      commandToken: "task-token",
      initialView: createWorkingView(),
      wakeToken: "parent-session-token",
    });

    expect(wakeTaskInputRequestParentStep).toHaveBeenCalledTimes(1);
    expect(wakeTaskParentStep).not.toHaveBeenCalled();
  });

  it("holds a fast authorization event until the readiness barrier", async () => {
    mockCommandHook([
      {
        callId: "call-task",
        childSessionId: "child-session",
        event: {
          data: {
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
      { command: { kind: "ready" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      commandToken: "task-token",
      initialView: createWorkingView(),
      wakeToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working", "input_required", "input_required"]);
    expect(wakeTaskAuthorizationParentStep).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(wakeTaskAuthorizationParentStep).mock.invocationCallOrder[0],
    ).toBeGreaterThan(vi.mocked(appendTaskSnapshotStep).mock.invocationCallOrder[2] ?? 0);
  });

  it("does not wake without a wake token and never wakes twice for one blocked child", async () => {
    mockCommandHook([
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
      commandToken: "task-token",
      initialView: createWorkingView(),
      wakeToken: "parent-session-token",
    });

    // input_required wakes once; the second require-input replaces the
    // batch without leaving the ready state, while terminal settlement
    // still wakes independently after direct HITL responses.
    expect(wakeTaskParentStep).toHaveBeenCalledTimes(2);

    vi.mocked(wakeTaskParentStep).mockClear();
    mockCommandHook([{ command: { data: "done", kind: "complete" }, kind: "task-command" }]);
    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });
    expect(wakeTaskParentStep).not.toHaveBeenCalled();
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
      commandToken: "task-token",
      initialView: createWorkingView(),
      wakeToken: "parent-session-token",
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
    const firstInputAppendOrder =
      vi.mocked(appendTaskSnapshotStep).mock.invocationCallOrder[2] ?? 0;
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
      kind: "task-answer-input",
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

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(deliverTaskInputResponsesStep).toHaveBeenCalledWith({
      answer: answer("q1"),
      requestIds: ["q1"],
    });
    expect(appendedStatuses()).toEqual(["working", "input_required", "working", "completed"]);
    const deliveryOrder = vi.mocked(deliverTaskInputResponsesStep).mock.invocationCallOrder[0] ?? 0;
    const unblockOrder = vi.mocked(appendTaskSnapshotStep).mock.invocationCallOrder[2] ?? 0;
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

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

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

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(deliverTaskInputResponsesStep).toHaveBeenCalledWith({
      answer: answer("q1", "unknown"),
      requestIds: ["q1"],
    });
    const blockedAgain = vi.mocked(appendTaskSnapshotStep).mock.calls[2]?.[0].view;
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

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(appendedStatuses()).toEqual(["working", "input_required", "completed"]);
  });

  it("ignores an answer addressed to a different task", async () => {
    vi.mocked(deliverTaskInputResponsesStep).mockResolvedValue("delivered");
    mockCommandHook([
      requireInput("q1"),
      { ...answer("q1"), taskId: "task_other" },
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(deliverTaskInputResponsesStep).not.toHaveBeenCalled();
    expect(appendedStatuses()).toEqual(["working", "input_required", "completed"]);
  });
});
