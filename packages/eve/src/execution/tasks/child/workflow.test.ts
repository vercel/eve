import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowToolRunRequestMessage } from "#execution/tools/workflow/messages.js";
import { taskRunWorkflow } from "#execution/tasks/child/workflow.js";
import type { TaskView } from "#tasks/types.js";

const mocks = vi.hoisted(() => ({
  appendTaskViewStep: vi.fn(),
  cancelWorkflowToolRunStep: vi.fn(),
  claimHookOwnership: vi.fn(),
  createChannelReader: vi.fn((channel: string) => ({ channel, iterator: [][Symbol.iterator]() })),
  createHook: vi.fn(() => ({ token: "task-token" })),
  deliverTaskInputResponsesStep: vi.fn(),
  disposeHook: vi.fn(),
  openWorkflowToolRunOwnerChannels: vi.fn(() => ({ dispose: vi.fn(), readers: [] })),
  raceChannelReads: vi.fn(),
  resumeHookStep: vi.fn(),
  wakeTaskEffectParentStep: vi.fn(),
  wakeTaskParentStep: vi.fn(),
  wakeTaskUpdateParentStep: vi.fn(),
  wakeWorkflowTaskInputRequestParentStep: vi.fn(),
  executeWorkflowBody: vi.fn(),
  createWorkflowBodyRef: vi.fn((input) => ({
    callId: input.callId,
    execution: input.execution,
    input: input.input,
    runId: "task-run",
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    turnId: input.session.turn.id,
  })),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  createHook: mocks.createHook,
}));
vi.mock("#execution/hook-ownership.js", () => ({
  claimHookOwnership: mocks.claimHookOwnership,
  disposeHook: mocks.disposeHook,
  isHookConflictError: () => false,
}));
vi.mock("#execution/tasks/child/steps.js", () => ({
  appendTaskViewStep: mocks.appendTaskViewStep,
  deliverTaskInputResponsesStep: mocks.deliverTaskInputResponsesStep,
  wakeTaskEffectParentStep: mocks.wakeTaskEffectParentStep,
  wakeTaskParentStep: mocks.wakeTaskParentStep,
  wakeTaskUpdateParentStep: mocks.wakeTaskUpdateParentStep,
  wakeWorkflowTaskInputRequestParentStep: mocks.wakeWorkflowTaskInputRequestParentStep,
}));
vi.mock("#execution/tools/workflow/cancel.js", () => ({
  cancelWorkflowToolRunStep: mocks.cancelWorkflowToolRunStep,
}));
vi.mock("#execution/tools/workflow/owner-channels.js", () => ({
  createChannelReader: mocks.createChannelReader,
  raceChannelReads: mocks.raceChannelReads,
}));
vi.mock("#execution/tools/workflow/owner.js", () => ({
  openWorkflowToolRunOwnerChannels: mocks.openWorkflowToolRunOwnerChannels,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.resumeHookStep,
}));
vi.mock("#execution/tools/workflow/body.js", () => ({
  createWorkflowBodyRef: mocks.createWorkflowBodyRef,
  executeWorkflowBody: mocks.executeWorkflowBody,
}));

const initialView = {
  metadata: { kind: "tool", name: "approval-worker" },
  status: "working",
  taskId: "task-1",
} satisfies TaskView;

const bufferedEffectRequest = {
  from: {
    callId: "tool-call-1",
    execution: "background",
    input: { message: "authorize" },
    runId: "run-1",
    stepIndex: 0,
    toolName: "approval-worker",
    turnId: "turn-parent",
  },
  replyTo: "agent-reply",
  request: {
    input: { phase: "waiting" },
    invocationId: "tool-call-1:approval:event:0",
    kind: "effect",
    name: "workflow.event",
  },
} satisfies WorkflowToolRunRequestMessage;

const workflowEffectRequest = {
  ...bufferedEffectRequest,
  request: {
    input: { phase: "waiting" },
    invocationId: "tool-call-1:event",
    kind: "effect",
    name: "workflow.event",
  },
} satisfies WorkflowToolRunRequestMessage;

describe("taskRunWorkflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createHook.mockReturnValue({ token: "task-token" });
    mocks.openWorkflowToolRunOwnerChannels.mockReturnValue({ dispose: vi.fn(), readers: [] });
    mocks.executeWorkflowBody.mockResolvedValue({ output: "done", status: "completed" });
  });

  it("buffers workflow effects until task dispatch is acknowledged", async () => {
    mocks.raceChannelReads
      .mockResolvedValueOnce({
        channel: "request",
        next: { done: false, value: bufferedEffectRequest },
      })
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
      })
      .mockResolvedValueOnce({ channel: "commands", next: { done: true, value: undefined } });

    await taskRunWorkflow({
      initialView,
      parentContinuationToken: "parent-token",
      taskInboxToken: "task-token",
    });

    expect(mocks.wakeTaskEffectParentStep).toHaveBeenCalledWith({
      request: bufferedEffectRequest,
      taskId: "task-1",
      token: "parent-token",
    });
    expect(mocks.raceChannelReads.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.wakeTaskEffectParentStep.mock.invocationCallOrder[0]!,
    );
  });

  it("forwards admitted workflow effects through the task's owner channel", async () => {
    mocks.raceChannelReads
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
      })
      .mockResolvedValueOnce({
        channel: "request",
        next: { done: false, value: workflowEffectRequest },
      })
      .mockResolvedValueOnce({ channel: "commands", next: { done: true, value: undefined } });

    await taskRunWorkflow({
      initialView,
      parentContinuationToken: "parent-token",
      taskInboxToken: "task-token",
    });

    expect(mocks.wakeTaskEffectParentStep).toHaveBeenCalledWith({
      request: workflowEffectRequest,
      taskId: "task-1",
      token: "parent-token",
    });
  });

  it("does not execute a workflow body before task admission", async () => {
    mocks.raceChannelReads.mockResolvedValueOnce({
      channel: "commands",
      next: { done: true, value: undefined },
    });

    await taskRunWorkflow({
      initialView,
      parentContinuationToken: "parent-token",
      taskInboxToken: "task-token",
      workflow: {
        callId: "call-1",
        input: {},
        session: {
          auth: { current: null, initiator: null },
          id: "session-1",
          turn: { id: "turn-1", sequence: 0 },
        },
        stepIndex: 0,
        toolName: "worker",
        workflowId: "workflow//eve//worker",
      },
    });

    expect(mocks.executeWorkflowBody).not.toHaveBeenCalled();
  });

  it("starts the workflow body only after ready", async () => {
    mocks.raceChannelReads
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
      })
      .mockResolvedValueOnce({ channel: "commands", next: { done: true, value: undefined } });

    await taskRunWorkflow({
      initialView,
      parentContinuationToken: "parent-token",
      taskInboxToken: "task-token",
      workflow: {
        callId: "call-1",
        input: {},
        session: {
          auth: { current: null, initiator: null },
          id: "session-1",
          turn: { id: "turn-1", sequence: 0 },
        },
        stepIndex: 0,
        toolName: "worker",
        workflowId: "workflow//eve//worker",
      },
    });

    expect(mocks.executeWorkflowBody).toHaveBeenCalledOnce();
  });

  it("flushes an update queued before readiness ahead of terminal completion", async () => {
    const update = {
      callId: "call-1",
      kind: "task-update" as const,
      message: "progress",
      updateEpoch: "task-1",
      updateIndex: 0,
    };
    mocks.raceChannelReads
      .mockResolvedValueOnce({ channel: "commands", next: { done: false, value: update } })
      .mockResolvedValueOnce({
        channel: "commands",
        next: {
          done: false,
          value: {
            command: { data: "done", kind: "complete" },
            kind: "task-command",
          },
        },
      })
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
      });

    await taskRunWorkflow({
      initialView,
      parentContinuationToken: "parent-token",
      taskInboxToken: "task-token",
    });

    expect(mocks.wakeTaskUpdateParentStep).toHaveBeenCalledWith({
      token: "parent-token",
      update,
      view: expect.objectContaining({ status: "completed" }),
    });
    expect(mocks.wakeTaskUpdateParentStep.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.wakeTaskParentStep.mock.invocationCallOrder[0]!,
    );
  });

  it("publishes cancellation after the workflow body observes its abort", async () => {
    mocks.raceChannelReads
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
      })
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "cancel" }, kind: "task-command" } },
      })
      .mockResolvedValueOnce({
        channel: "body",
        next: { done: false, value: { reason: "cancelled", status: "cancelled" } },
      });
    mocks.executeWorkflowBody.mockImplementation(
      async (_input, signal: AbortSignal) =>
        await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ reason: "cancelled", status: "cancelled" }),
            { once: true },
          );
        }),
    );

    await taskRunWorkflow({
      initialView,
      parentContinuationToken: "parent-token",
      taskInboxToken: "task-token",
      workflow: {
        callId: "call-1",
        input: {},
        session: {
          auth: { current: null, initiator: null },
          id: "session-1",
          turn: { id: "turn-1", sequence: 0 },
        },
        stepIndex: 0,
        toolName: "worker",
        workflowId: "workflow//eve//worker",
      },
    });

    expect(mocks.wakeTaskParentStep).toHaveBeenCalledWith({
      token: "parent-token",
      view: expect.objectContaining({ status: "cancelled" }),
    });
  });
});
