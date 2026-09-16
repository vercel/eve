import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { taskRunWorkflow } from "#execution/tasks/child/workflow.js";
import type { TaskView } from "#tasks/types.js";
import {
  createAuthorizationRequiredEvent,
  createAuthorizationCompletedEvent,
} from "#protocol/message.js";

const mocks = vi.hoisted(() => ({
  appendTaskProgressStep: vi.fn(),
  appendTaskViewStep: vi.fn(),
  cancelWorkflowToolRunStep: vi.fn(),
  claimHookOwnership: vi.fn(),
  createChannelReader: vi.fn((channel: string) => ({ channel, iterator: [][Symbol.iterator]() })),
  createHook: vi.fn(() => ({ token: "task-token" })),
  deliverTaskInputResponsesStep: vi.fn(),
  raceChannelReads: vi.fn(),
  resumeHookStep: vi.fn(),
  wakeTaskAgentRequestParentStep: vi.fn(),
  wakeTaskAuthorizationParentStep: vi.fn(),
  wakeTaskParentStep: vi.fn(),
  wakeTaskUpdateParentStep: vi.fn(),
  wakeWorkflowTaskInputRequestParentStep: vi.fn(),
  createWorkflowToolInvocationReader: vi.fn(() => ({ channel: "workflow" })),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  createHook: mocks.createHook,
}));
vi.mock("#execution/hook-ownership.js", () => ({
  claimHookOwnership: mocks.claimHookOwnership,
  isHookConflictError: () => false,
}));
vi.mock("#execution/tasks/child/steps.js", () => ({
  appendTaskProgressStep: mocks.appendTaskProgressStep,
  appendTaskViewStep: mocks.appendTaskViewStep,
  deliverTaskInputResponsesStep: mocks.deliverTaskInputResponsesStep,
  wakeTaskAgentRequestParentStep: mocks.wakeTaskAgentRequestParentStep,
  wakeTaskAuthorizationParentStep: mocks.wakeTaskAuthorizationParentStep,
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
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.resumeHookStep,
}));
vi.mock("#execution/tools/workflow/invocation.js", () => ({
  createWorkflowToolInvocationReader: mocks.createWorkflowToolInvocationReader,
}));

const initialView = {
  metadata: { kind: "tool", name: "approval-worker" },
  status: "working",
  taskId: "task-1",
} satisfies TaskView;

const bufferedAgentRequest = {
  kind: "request",
  from: {
    callId: "tool-call-1",
    execution: "background",
    input: { message: "authorize" },
    runId: "run-1",
    sequence: 0,
    stepIndex: 0,
    toolName: "approval-worker",
    turnId: "turn-parent",
  },
  replyTo: "agent-reply",
  request: {
    input: { message: "authorize", target: "approver" },
    invocationId: "tool-call-1:approver",
    kind: "agent-invoke",
  },
} satisfies WorkflowToolRunMessage;

const workflowAgentRequest = {
  ...bufferedAgentRequest,
  request: {
    input: { message: "authorize", target: "approver" },
    invocationId: "tool-call-1:approver:2",
    kind: "agent-invoke",
  },
} satisfies WorkflowToolRunMessage;

function authorizationRequest(attemptId: string, completed = false) {
  const data = { attemptId, name: "github", sequence: 0, stepIndex: 0, turnId: "turn-parent" };
  return {
    ...bufferedAgentRequest,
    replyTo: `ack-${attemptId}`,
    request: {
      kind: "authorization-request",
      event: {
        kind: "subagent-authorization-event",
        callId: "tool-call-1",
        childSessionId: "run-1",
        subagentName: "approval-worker",
        event: completed
          ? createAuthorizationCompletedEvent({ ...data, outcome: "authorized" })
          : createAuthorizationRequiredEvent({ ...data, description: "Sign in" }),
      },
    },
  } satisfies WorkflowToolRunMessage;
}

function queueOwnerRequest(value: WorkflowToolRunMessage) {
  mocks.raceChannelReads.mockResolvedValueOnce({
    channel: "workflow",
    next: { done: false, value },
  });
}

function queueCommand(command: import("#tasks/types.js").TaskCommand) {
  mocks.raceChannelReads.mockResolvedValueOnce({
    channel: "commands",
    next: { done: false, value: { kind: "task-command", command } },
  });
}

const workflowInput = {
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
};

describe("taskRunWorkflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createHook.mockReturnValue({ token: "task-token" });
    mocks.createWorkflowToolInvocationReader.mockReturnValue({ channel: "workflow" });
  });

  it("persists auth requests and answers before forwarding and acknowledging each event", async () => {
    queueCommand({ kind: "ready" });
    queueOwnerRequest(authorizationRequest("a"));
    queueOwnerRequest(authorizationRequest("b"));
    queueOwnerRequest(authorizationRequest("a", true));
    queueOwnerRequest(authorizationRequest("b", true));
    mocks.raceChannelReads.mockResolvedValueOnce({ channel: "commands", next: { done: true } });

    await taskRunWorkflow(workflowInput);

    const views = mocks.appendTaskViewStep.mock.calls.slice(-4).map(([input]) => input.view);
    expect(views.map((view) => view.status)).toEqual([
      "input_required",
      "input_required",
      "input_required",
      "working",
    ]);
    expect(
      views
        .slice(0, 3)
        .map((view) =>
          view.inputRequests.map((request: { requestId: string }) => request.requestId),
        ),
    ).toEqual([["a"], ["a", "b"], ["b"]]);
    expect(mocks.wakeTaskAuthorizationParentStep).toHaveBeenCalledTimes(4);
    expect(mocks.resumeHookStep).toHaveBeenCalledTimes(4);
    expect(mocks.wakeTaskParentStep).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) {
      expect(mocks.appendTaskViewStep.mock.invocationCallOrder[i + 2]).toBeLessThan(
        mocks.wakeTaskAuthorizationParentStep.mock.invocationCallOrder[i]!,
      );
      expect(mocks.wakeTaskAuthorizationParentStep.mock.invocationCallOrder[i]).toBeLessThan(
        mocks.resumeHookStep.mock.invocationCallOrder[i]!,
      );
    }
  });

  it("forwards child-agent auth without treating it as the workflow's own request", async () => {
    const message = authorizationRequest("child");
    message.request.event.childSessionId = "child-session";
    queueCommand({ kind: "ready" });
    queueOwnerRequest(message);
    mocks.raceChannelReads.mockResolvedValueOnce({ channel: "commands", next: { done: true } });

    await taskRunWorkflow(workflowInput);

    expect(mocks.wakeTaskAuthorizationParentStep).toHaveBeenCalledExactlyOnceWith({
      request: message.request,
      taskId: initialView.taskId,
      token: workflowInput.parentContinuationToken,
    });
    expect(mocks.resumeHookStep).not.toHaveBeenCalled();
    expect(
      mocks.appendTaskViewStep.mock.calls.some(([input]) => input.view.status === "input_required"),
    ).toBe(false);
  });

  it.each(["persistence", "forwarding"])(
    "does not acknowledge auth after failed %s",
    async (failure) => {
      queueCommand({ kind: "ready" });
      queueOwnerRequest(authorizationRequest("a"));
      if (failure === "persistence") {
        mocks.appendTaskViewStep.mockImplementation(async ({ view }) => {
          if (view.status === "input_required") throw new Error("failed persistence");
        });
      } else {
        mocks.wakeTaskAuthorizationParentStep.mockRejectedValue(new Error("failed forwarding"));
      }

      await expect(taskRunWorkflow(workflowInput)).rejects.toThrow(`failed ${failure}`);
      expect(mocks.resumeHookStep).not.toHaveBeenCalled();
    },
  );

  it("forwards admitted agent requests through the task's owner channel", async () => {
    mocks.raceChannelReads
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
      })
      .mockResolvedValueOnce({
        channel: "workflow",
        next: { done: false, value: workflowAgentRequest },
      })
      .mockResolvedValueOnce({ channel: "commands", next: { done: true, value: undefined } });

    await taskRunWorkflow(workflowInput);

    expect(mocks.wakeTaskAgentRequestParentStep).toHaveBeenCalledWith({
      request: workflowAgentRequest,
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

    expect(mocks.createWorkflowToolInvocationReader).not.toHaveBeenCalled();
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

    expect(mocks.createWorkflowToolInvocationReader).toHaveBeenCalledOnce();
    expect(mocks.createWorkflowToolInvocationReader).toHaveBeenCalledWith(
      expect.objectContaining({ execution: "background" }),
      expect.any(AbortSignal),
    );
  });

  it.each(["tool", "subagent"])(
    "routes %s progress without changing subagent delivery",
    async (kind) => {
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
        ...workflowInput,
        initialView: { ...initialView, metadata: { ...initialView.metadata, kind } },
      });

      if (kind === "subagent") {
        expect(mocks.appendTaskProgressStep).not.toHaveBeenCalled();
        expect(mocks.wakeTaskUpdateParentStep).toHaveBeenCalledWith({
          token: "parent-token",
          update,
          view: expect.objectContaining({ status: "completed" }),
        });
        expect(mocks.wakeTaskUpdateParentStep.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.wakeTaskParentStep.mock.invocationCallOrder[0]!,
        );
        return;
      }
      expect(mocks.appendTaskProgressStep).toHaveBeenCalledWith({
        progress: {
          callId: "call-1",
          kind: "task-progress",
          taskId: "task-1",
          update: "progress",
          updateIndex: 0,
        },
      });
      expect(mocks.wakeTaskUpdateParentStep).not.toHaveBeenCalled();
    },
  );

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
        channel: "workflow",
        next: {
          done: false,
          value: {
            from: bufferedAgentRequest.from,
            kind: "outcome",
            result: { reason: "cancelled", status: "cancelled" },
          },
        },
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

    expect(mocks.wakeTaskParentStep).toHaveBeenCalledWith({
      token: "parent-token",
      view: expect.objectContaining({ status: "cancelled" }),
    });
  });

  it("keeps explicit cancellation final when the invocation completes late", async () => {
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
        channel: "workflow",
        next: {
          done: false,
          value: {
            from: bufferedAgentRequest.from,
            kind: "outcome",
            result: { output: "late success", status: "completed" },
          },
        },
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

    expect(mocks.appendTaskViewStep.mock.calls.map(([input]) => input.view.status)).toEqual([
      "working",
      "working",
      "cancelled",
    ]);
    expect(mocks.wakeTaskParentStep).toHaveBeenLastCalledWith({
      token: "parent-token",
      view: expect.objectContaining({ status: "cancelled" }),
    });
  });

  it("applies a persisted report before the invocation outcome", async () => {
    mocks.raceChannelReads
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
      })
      .mockResolvedValueOnce({
        channel: "workflow",
        next: {
          done: false,
          value: {
            kind: "report",
            from: bufferedAgentRequest.from,
            update: "Review the export",
          },
        },
      })
      .mockResolvedValueOnce({
        channel: "workflow",
        next: {
          done: false,
          value: {
            from: bufferedAgentRequest.from,
            kind: "outcome",
            result: { output: "done", status: "completed" },
          },
        },
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
    expect(mocks.appendTaskProgressStep).toHaveBeenCalledWith({
      progress: expect.objectContaining({ update: "Review the export" }),
    });
    expect(mocks.appendTaskProgressStep.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.wakeTaskParentStep.mock.invocationCallOrder[0]!,
    );
  });
});
