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
  dispatchTaskAgentInvocationStep: vi.fn(),
  disposeHook: vi.fn(),
  openWorkflowToolRunOwnerChannels: vi.fn(() => ({ dispose: vi.fn(), readers: [] })),
  raceChannelReads: vi.fn(),
  resumeHookStep: vi.fn(),
  sendAgentHandleCommandStep: vi.fn(),
  wakeTaskAgentEventParentStep: vi.fn(),
  wakeTaskParentStep: vi.fn(),
  wakeTaskUpdateParentStep: vi.fn(),
  wakeWorkflowTaskInputRequestParentStep: vi.fn(),
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
vi.mock("#execution/session-command-inbox.js", () => ({
  sendAgentHandleCommandStep: mocks.sendAgentHandleCommandStep,
}));
vi.mock("#execution/tasks/child/steps.js", () => ({
  appendTaskViewStep: mocks.appendTaskViewStep,
  deliverTaskInputResponsesStep: mocks.deliverTaskInputResponsesStep,
  wakeTaskAgentEventParentStep: mocks.wakeTaskAgentEventParentStep,
  wakeTaskParentStep: mocks.wakeTaskParentStep,
  wakeTaskUpdateParentStep: mocks.wakeTaskUpdateParentStep,
  wakeWorkflowTaskInputRequestParentStep: mocks.wakeWorkflowTaskInputRequestParentStep,
}));
vi.mock("#execution/tools/subagent/invocation-step.js", () => ({
  dispatchTaskAgentInvocationStep: mocks.dispatchTaskAgentInvocationStep,
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

const initialView = {
  metadata: { kind: "tool", name: "approval-worker" },
  status: "working",
  taskId: "task-1",
} satisfies TaskView;

const authorizationEventRequest = {
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
    input: {
      callId: "tool-call-1:approval",
      childSessionId: "child-1",
      event: {
        data: {
          description: "Authorize Linear",
          name: "linear",
          sequence: 1,
          stepIndex: 2,
          turnId: "turn-child",
        },
        type: "authorization.required",
      },
      kind: "subagent-authorization-event",
      subagentName: "approval-worker",
    },
    invocationId: "tool-call-1:approval:event:0",
    kind: "effect",
    name: "agent.event",
  },
} satisfies WorkflowToolRunRequestMessage;

describe("taskRunWorkflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createHook.mockReturnValue({ token: "task-token" });
    mocks.openWorkflowToolRunOwnerChannels.mockReturnValue({ dispose: vi.fn(), readers: [] });
  });

  it("buffers task-owned agent events until task dispatch is acknowledged", async () => {
    mocks.raceChannelReads
      .mockResolvedValueOnce({
        channel: "request",
        next: { done: false, value: authorizationEventRequest },
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

    expect(mocks.wakeTaskAgentEventParentStep).toHaveBeenCalledWith({
      request: authorizationEventRequest,
      taskId: "task-1",
      token: "parent-token",
    });
    expect(mocks.raceChannelReads.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.wakeTaskAgentEventParentStep.mock.invocationCallOrder[0]!,
    );
  });
});
