import { assert, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { workflowToolRunWorkflow } from "#execution/tools/workflow/workflow.js";
import type { TaskCommand, TaskView } from "#tasks/types.js";
import {
  createAuthorizationRequiredEvent,
  createAuthorizationCompletedEvent,
} from "#protocol/message.js";

const mocks = vi.hoisted(() => ({
  emitTaskActivityStep: vi.fn(),
  claimHookOwnership: vi.fn(),
  createChannelReader: vi.fn((channel: string) => ({
    channel,
    landed: [],
    iterator: [][Symbol.iterator](),
  })),
  createHook: vi.fn(() => ({ token: "task-token" })),
  deliverTaskInputResponsesStep: vi.fn(),
  raceChannelReads: vi.fn(),
  resumeHookStep: vi.fn(),
  notifyTaskParent: vi.fn(),
  executeWorkflowBody: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  createHook: mocks.createHook,
  sleep: mocks.sleep,
}));
vi.mock("#execution/hook-ownership.js", () => ({
  claimHookOwnership: mocks.claimHookOwnership,
  isHookConflictError: () => false,
}));
vi.mock("#execution/tasks/child/notify.js", () => ({
  emitTaskActivityStep: mocks.emitTaskActivityStep,
  deliverTaskInputResponsesStep: mocks.deliverTaskInputResponsesStep,
  notifyTaskParent: mocks.notifyTaskParent,
}));
vi.mock("#execution/tools/workflow/owner-channels.js", () => ({
  createChannelReader: mocks.createChannelReader,
  raceChannelReads: mocks.raceChannelReads,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.resumeHookStep,
}));
vi.mock("#execution/tools/workflow/body.js", () => ({
  executeWorkflowBody: mocks.executeWorkflowBody,
  createWorkflowBodyRef: () => bufferedAgentRequest.from,
}));
vi.mock("#execution/tools/workflow/owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tools/workflow/owner.js")>()),
  openWorkflowToolRunOwnerInbox: () => ({
    owner: { inbox: "owner" },
    reader: { channel: "workflow" },
  }),
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
  mocks.raceChannelReads.mockResolvedValueOnce(
    value.kind === "outcome"
      ? {
          channel: "body",
          next: { done: false, value: { outcome: value.result, reportCount: 0 } },
        }
      : {
          channel: "workflow",
          next: { done: false, value },
        },
  );
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

describe("workflowToolRunWorkflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createHook.mockReturnValue({ token: "task-token" });
    mocks.executeWorkflowBody.mockReturnValue(new Promise(() => {}));
    mocks.sleep.mockReturnValue(new Promise(() => {}));
  });

  it("forwards auth events before acknowledging them", async () => {
    queueCommand({ kind: "ready" });
    queueOwnerRequest(authorizationRequest("a"));
    queueOwnerRequest(authorizationRequest("b"));
    queueOwnerRequest(authorizationRequest("a", true));
    queueOwnerRequest(authorizationRequest("b", true));
    mocks.raceChannelReads.mockResolvedValueOnce({ channel: "commands", next: { done: true } });

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.notifyTaskParent).toHaveBeenCalledTimes(4);
    expect(mocks.resumeHookStep).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 4; i++) {
      const notified = mocks.notifyTaskParent.mock.invocationCallOrder[i];
      const acknowledged = mocks.resumeHookStep.mock.invocationCallOrder[i];
      assert(notified !== undefined && acknowledged !== undefined);
      expect(notified).toBeLessThan(acknowledged);
    }
  });

  it("keeps ordinary input answerable when authorization completes with the same request id", async () => {
    const requestId = "request-1";
    const answer = {
      kind: "input-response" as const,
      childContinuationToken: "answer-hook",
      taskId: initialView.taskId,
      inputResponses: [{ requestId, optionId: "approve" }],
    };
    queueCommand({ kind: "ready" });
    queueOwnerRequest({
      ...bufferedAgentRequest,
      replyTo: "answer-hook",
      request: {
        kind: "tool-approval",
        requestId,
        prompt: "Approve deployment?",
        action: { kind: "tool-call", callId: "deploy", toolName: "deploy", input: {} },
      },
    });
    queueOwnerRequest(authorizationRequest(requestId));
    queueOwnerRequest(authorizationRequest(requestId, true));
    mocks.deliverTaskInputResponsesStep.mockResolvedValue("delivered");
    mocks.raceChannelReads.mockResolvedValueOnce({
      channel: "commands",
      next: { done: false, value: answer },
    });
    mocks.raceChannelReads.mockResolvedValueOnce({ channel: "commands", next: { done: true } });

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.deliverTaskInputResponsesStep).toHaveBeenCalledExactlyOnceWith({
      answer,
      answerHook: { runId: "run-1" },
      requestIds: [requestId],
    });
  });

  it("discards sandbox requests after background cancellation", async () => {
    queueCommand({ kind: "ready" });
    queueCommand({ kind: "cancel" });
    queueOwnerRequest({
      ...bufferedAgentRequest,
      replyTo: "eve.sandbox.step-1",
      request: { kind: "sandbox-request" },
    });
    mocks.raceChannelReads.mockResolvedValueOnce({ channel: "commands", next: { done: true } });
    await workflowToolRunWorkflow(workflowInput);
    expect(mocks.notifyTaskParent).toHaveBeenCalledExactlyOnceWith({
      token: "parent-token",
      view: { ...initialView, status: "cancelled" },
    });
  });

  it("acknowledges discarded authorization prompts after cancellation", async () => {
    queueCommand({ kind: "ready" });
    queueCommand({ kind: "cancel" });
    queueOwnerRequest(authorizationRequest("late"));
    mocks.raceChannelReads.mockResolvedValueOnce({ channel: "commands", next: { done: true } });

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.notifyTaskParent).toHaveBeenCalledExactlyOnceWith({
      token: "parent-token",
      view: { ...initialView, status: "cancelled" },
    });
    expect(mocks.resumeHookStep).toHaveBeenCalledExactlyOnceWith("ack-late", null, {
      ifPresent: true,
    });
  });

  it("forwards child-agent auth without treating it as the workflow's own request", async () => {
    const message = authorizationRequest("child");
    message.request.event.childSessionId = "child-session";
    queueCommand({ kind: "ready" });
    queueOwnerRequest(message);
    mocks.raceChannelReads.mockResolvedValueOnce({ channel: "commands", next: { done: true } });

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.notifyTaskParent).toHaveBeenCalledExactlyOnceWith({
      request: message,
      taskId: initialView.taskId,
      token: workflowInput.parentContinuationToken,
    });
    expect(mocks.resumeHookStep).not.toHaveBeenCalled();
    expect(
      mocks.emitTaskActivityStep.mock.calls.some(
        ([input]) => input.view.status === "input_required",
      ),
    ).toBe(false);
  });

  it("does not acknowledge auth after failed forwarding", async () => {
    queueCommand({ kind: "ready" });
    queueOwnerRequest(authorizationRequest("a"));
    mocks.notifyTaskParent.mockRejectedValue(new Error("failed forwarding"));
    await expect(workflowToolRunWorkflow(workflowInput)).rejects.toThrow("failed forwarding");
    expect(mocks.resumeHookStep).not.toHaveBeenCalled();
  });

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

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.notifyTaskParent).toHaveBeenCalledWith({
      request: workflowAgentRequest,
      taskId: "task-1",
      token: "parent-token",
    });
  });

  it("waits for agent settlement delivery before publishing task completion", async () => {
    const delivery = Promise.withResolvers<void>();
    const delivering = Promise.withResolvers<void>();
    mocks.notifyTaskParent.mockImplementationOnce(() => {
      delivering.resolve();
      return delivery.promise;
    });
    const settlement = {
      ...bufferedAgentRequest,
      request: {
        kind: "agent-settled",
        result: {
          callId: "nested",
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "parked",
            result: { kind: "succeeded", output: "done" },
            usageDelta: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 2,
              outputTokens: 3,
            },
          },
          output: "done",
          subagentName: "research",
        },
      },
    } satisfies WorkflowToolRunMessage;
    queueCommand({ kind: "ready" });
    queueOwnerRequest(settlement);
    queueOwnerRequest({
      kind: "outcome",
      from: bufferedAgentRequest.from,
      result: { status: "completed", output: "done" },
    });
    const execution = workflowToolRunWorkflow(workflowInput);
    await delivering.promise;
    expect(mocks.notifyTaskParent).toHaveBeenCalledTimes(1);
    delivery.resolve();
    await execution;
    expect(mocks.notifyTaskParent).toHaveBeenNthCalledWith(1, {
      request: settlement,
      taskId: "task-1",
      token: "parent-token",
    });
    expect(mocks.notifyTaskParent).toHaveBeenNthCalledWith(2, {
      token: "parent-token",
      view: expect.objectContaining({ status: "completed" }),
    });
  });

  it("does not execute a workflow body before task admission", async () => {
    mocks.raceChannelReads.mockResolvedValueOnce({
      channel: "commands",
      next: { done: true, value: undefined },
    });

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.executeWorkflowBody).not.toHaveBeenCalled();
  });

  it.each(["ready", "reject-dispatch"] as const)(
    "does not start pre-admission cancelled work after %s",
    async (kind) => {
      queueCommand({ kind: "cancel" });
      queueCommand(kind === "ready" ? { kind } : { kind, data: "step failed" });

      await workflowToolRunWorkflow(workflowInput);

      expect(mocks.executeWorkflowBody).not.toHaveBeenCalled();
      expect(mocks.notifyTaskParent).toHaveBeenCalledTimes(kind === "ready" ? 1 : 0);
      if (kind === "ready")
        expect(mocks.notifyTaskParent).toHaveBeenLastCalledWith({
          token: "parent-token",
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

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.executeWorkflowBody).toHaveBeenCalledOnce();
    expect(mocks.executeWorkflowBody).toHaveBeenCalledWith(
      expect.objectContaining({ execution: "background" }),
      expect.any(AbortSignal),
    );
  });

  it.each(["tool", "subagent"])(
    "consumes %s progress and only forwards subagent updates",
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
          channel: "body",
          next: {
            done: false,
            value: {
              reportCount: 0,
              outcome: { status: "completed", output: "done" },
            },
          },
        });

      await workflowToolRunWorkflow({
        ...workflowInput,
        initialView: { ...initialView, metadata: { ...initialView.metadata, kind } },
      });

      if (kind === "subagent") {
        expect(mocks.notifyTaskParent).toHaveBeenNthCalledWith(1, {
          token: "parent-token",
          update: { report: expect.objectContaining(report), index: 0 },
          view: expect.objectContaining({ status: "working" }),
        });
        expect(mocks.notifyTaskParent).toHaveBeenNthCalledWith(2, {
          token: "parent-token",
          view: expect.objectContaining({ status: "completed" }),
        });
        return;
      }
      expect(mocks.notifyTaskParent).toHaveBeenCalledTimes(1);
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
        channel: "body",
        next: {
          done: false,
          value: {
            reportCount: 0,
            outcome: { reason: "cancelled", status: "cancelled" },
          },
        },
      });

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.notifyTaskParent).toHaveBeenCalledWith({
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

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.raceChannelReads).toHaveBeenCalledTimes(6);
    expect(mocks.executeWorkflowBody).toHaveBeenCalledOnce();
    expect(mocks.resumeHookStep).toHaveBeenCalledExactlyOnceWith("ack-cleanup", null, {
      ifPresent: true,
    });
    expect(mocks.notifyTaskParent).toHaveBeenCalledTimes(2);
    const acknowledged = mocks.resumeHookStep.mock.invocationCallOrder[0];
    const completed = mocks.notifyTaskParent.mock.invocationCallOrder[1];
    assert(acknowledged !== undefined && completed !== undefined);
    expect(acknowledged).toBeLessThan(completed);
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
        channel: "body",
        next: {
          done: false,
          value: {
            reportCount: 0,
            outcome: { output: "late success", status: "completed" },
          },
        },
      });

    await workflowToolRunWorkflow(workflowInput);

    expect(mocks.notifyTaskParent).toHaveBeenCalledWith({
      token: "parent-token",
      view: expect.objectContaining({ status: "cancelled" }),
    });
    expect(mocks.notifyTaskParent).toHaveBeenLastCalledWith({
      token: "parent-token",
      view: expect.objectContaining({ status: "cancelled" }),
    });
  });

  it("drains background yields before delivering the return value without progress notifications", async () => {
    mocks.raceChannelReads
      .mockResolvedValueOnce({
        channel: "commands",
        next: { done: false, value: { command: { kind: "ready" }, kind: "task-command" } },
      })
      .mockResolvedValueOnce({
        channel: "body",
        next: {
          done: false,
          value: {
            reportCount: 1,
            outcome: { output: "done", status: "completed" },
          },
        },
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
      });
    await workflowToolRunWorkflow(workflowInput);
    expect(mocks.raceChannelReads).toHaveBeenCalledTimes(3);
    expect(mocks.notifyTaskParent).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTaskParent).toHaveBeenCalledExactlyOnceWith({
      token: "parent-token",
      view: expect.objectContaining({
        status: "completed",
        lastOutput: { type: "result", data: "done" },
      }),
    });
  });
});
