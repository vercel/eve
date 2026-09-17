import { assert, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { runBackgroundWorkflowTool } from "#execution/tools/workflow/background-owner.js";
import type { TaskCommand, TaskView } from "#tasks/types.js";
import {
  createAuthorizationRequiredEvent,
  createAuthorizationCompletedEvent,
} from "#protocol/message.js";

const mocks = vi.hoisted(() => ({
  appendTaskProgressStep: vi.fn(),
  appendTaskViewStep: vi.fn(),
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
  runWorkflowToolInvocation: vi.fn(async function* () {}),
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
vi.mock("#execution/tools/workflow/owner-channels.js", () => ({
  createChannelReader: mocks.createChannelReader,
  raceChannelReads: mocks.raceChannelReads,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.resumeHookStep,
}));
vi.mock("#execution/tools/workflow/invocation.js", () => ({
  runWorkflowToolInvocation: mocks.runWorkflowToolInvocation,
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

function queueCommand(command: TaskCommand) {
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

describe("runBackgroundWorkflowTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createHook.mockReturnValue({ token: "task-token" });
  });

  it("persists auth requests and answers before forwarding and acknowledging each event", async () => {
    queueCommand({ kind: "ready" });
    queueOwnerRequest(authorizationRequest("a"));
    queueOwnerRequest(authorizationRequest("b"));
    queueOwnerRequest(authorizationRequest("a", true));
    queueOwnerRequest(authorizationRequest("b", true));
    mocks.raceChannelReads.mockResolvedValueOnce({ channel: "commands", next: { done: true } });

    await runBackgroundWorkflowTool(workflowInput);

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
      const committed = mocks.appendTaskViewStep.mock.invocationCallOrder[i + 1];
      const notified = mocks.wakeTaskAuthorizationParentStep.mock.invocationCallOrder[i];
      const acknowledged = mocks.resumeHookStep.mock.invocationCallOrder[i];
      assert(committed !== undefined && notified !== undefined && acknowledged !== undefined);
      expect(committed).toBeLessThan(notified);
      expect(notified).toBeLessThan(acknowledged);
    }
  });

  it("forwards child-agent auth without treating it as the workflow's own request", async () => {
    const message = authorizationRequest("child");
    message.request.event.childSessionId = "child-session";
    queueCommand({ kind: "ready" });
    queueOwnerRequest(message);
    mocks.raceChannelReads.mockResolvedValueOnce({ channel: "commands", next: { done: true } });

    await runBackgroundWorkflowTool(workflowInput);

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

      await expect(runBackgroundWorkflowTool(workflowInput)).rejects.toThrow(`failed ${failure}`);
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

    await runBackgroundWorkflowTool(workflowInput);

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

    await runBackgroundWorkflowTool(workflowInput);

    expect(mocks.runWorkflowToolInvocation).not.toHaveBeenCalled();
  });

  it.each(["ready", "reject-dispatch"] as const)(
    "does not start pre-admission cancelled work after %s",
    async (kind) => {
      queueCommand({ kind: "cancel" });
      queueCommand(kind === "ready" ? { kind } : { kind, data: "step failed" });

      await runBackgroundWorkflowTool(workflowInput);

      expect(mocks.runWorkflowToolInvocation).not.toHaveBeenCalled();
      expect(mocks.wakeTaskParentStep).toHaveBeenCalledTimes(kind === "ready" ? 1 : 0);
      expect(mocks.appendTaskViewStep).toHaveBeenLastCalledWith({
        activityObserver: undefined,
        view: { ...initialView, status: "cancelled" },
      });
    },
  );

  it("starts the workflow body only after ready", async () => {
    mocks.raceChannelReads
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
      })
      .mockResolvedValueOnce({ channel: "commands", next: { done: true, value: undefined } });

    await runBackgroundWorkflowTool(workflowInput);

    expect(mocks.runWorkflowToolInvocation).toHaveBeenCalledOnce();
    expect(mocks.runWorkflowToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ execution: "background" }),
      expect.any(AbortSignal),
    );
  });

  it.each(["tool", "subagent"])(
    "routes %s progress without changing subagent delivery",
    async (kind) => {
      const report = {
        from: { ...bufferedAgentRequest.from, callId: "call-1" },
        update: "progress",
      };
      mocks.raceChannelReads
        .mockResolvedValueOnce({
          channel: "commands",
          next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
        })
        .mockResolvedValueOnce({
          channel: "workflow",
          next: { done: false, value: { ...report, kind: "report" } },
        })
        .mockResolvedValueOnce({
          channel: "workflow",
          next: {
            done: false,
            value: {
              from: report.from,
              kind: "outcome",
              result: { status: "completed", output: "done" },
            },
          },
        });

      await runBackgroundWorkflowTool({
        ...workflowInput,
        initialView: { ...initialView, metadata: { ...initialView.metadata, kind } },
      });

      if (kind === "subagent") {
        expect(mocks.appendTaskProgressStep).not.toHaveBeenCalled();
        expect(mocks.wakeTaskUpdateParentStep).toHaveBeenCalledWith({
          token: "parent-token",
          report: expect.objectContaining(report),
          updateIndex: 0,
          view: expect.objectContaining({ status: "working" }),
        });
        expect(mocks.wakeTaskUpdateParentStep).toHaveBeenCalledBefore(mocks.wakeTaskParentStep);
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

    await runBackgroundWorkflowTool(workflowInput);

    expect(mocks.wakeTaskParentStep).toHaveBeenCalledWith({
      token: "parent-token",
      view: expect.objectContaining({ status: "cancelled" }),
    });
  });

  it("ignores duplicate admission commands while cancelled work finishes cleanup", async () => {
    queueCommand({ kind: "ready" });
    queueCommand({ kind: "cancel" });
    queueCommand({ kind: "ready" });
    queueCommand({ kind: "reject-dispatch", data: "late rejection" });
    queueOwnerRequest(authorizationRequest("cleanup", true));
    queueOwnerRequest({
      from: bufferedAgentRequest.from,
      kind: "outcome",
      result: { status: "cancelled", reason: "stop" },
    });

    await runBackgroundWorkflowTool(workflowInput);

    expect(mocks.raceChannelReads).toHaveBeenCalledTimes(6);
    expect(mocks.runWorkflowToolInvocation).toHaveBeenCalledOnce();
    expect(mocks.resumeHookStep).toHaveBeenCalledExactlyOnceWith("ack-cleanup", null, {
      ifPresent: true,
    });
    expect(mocks.wakeTaskParentStep).toHaveBeenCalledOnce();
    expect(mocks.resumeHookStep).toHaveBeenCalledBefore(mocks.wakeTaskParentStep);
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

    await runBackgroundWorkflowTool(workflowInput);

    expect(mocks.appendTaskViewStep.mock.calls.map(([input]) => input.view.status)).toEqual([
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
    await runBackgroundWorkflowTool(workflowInput);
    expect(mocks.appendTaskProgressStep).toHaveBeenCalledWith({
      progress: expect.objectContaining({ update: "Review the export" }),
    });
    expect(mocks.appendTaskProgressStep).toHaveBeenCalledBefore(mocks.wakeTaskParentStep);
  });
});
