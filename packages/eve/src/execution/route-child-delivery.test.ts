import { registerWorkflowToolRun, recordWorkflowTaskView } from "#harness/workflow-tool-runs.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import {
  emitRecordedTaskInputRequestStep,
  runProxySubagentEventStep,
} from "#subagents/event-proxy-step.js";
import {
  recordTaskInputRequestStep,
  recordTerminalTaskViewsStep,
} from "#execution/tasks/parent/hitl-proxy-steps.js";
import { acceptTaskAuthorizationEventStep } from "#execution/tools/subagent/accept-event-step.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  dispatchTaskAgentInvocationStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

vi.mock("#subagents/event-proxy-step.js", () => ({
  emitRecordedTaskInputRequestStep: vi.fn(),
  runProxySubagentEventStep: vi.fn(),
}));
vi.mock("#execution/tasks/parent/hitl-proxy-steps.js", () => ({
  recordTaskInputRequestStep: vi.fn(),
  recordTerminalTaskViewsStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/accept-event-step.js", () => ({
  acceptTaskAuthorizationEventStep: vi.fn(),
}));
vi.mock("#execution/proxied-deliver-step.js", () => ({
  routeProxiedDeliverStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  dispatchTaskAgentInvocationStep: vi.fn(),
  settleTaskAgentInvocationStep: vi.fn(),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: vi.fn(),
}));

const state = (hasProxyInputRequests: boolean): DurableSessionState =>
  createTestSessionState({
    continuationToken: "parent-token",
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "" },
    hasProxyInputRequests,
    sessionId: "parent-session",
    version: 1,
  });

const taskRequest = {
  replyTo: "eve:workflow-tool-run-answer:run-1:0",
  request: {
    action: { callId: "call-q", input: {}, kind: "tool-call" as const, toolName: "ask" },
    kind: "question" as const,
    prompt: "Which?",
    requestId: "request-1",
  },
  sequence: 1,
  stepIndex: 2,
  taskId: "task-1",
  turnId: "turn_child",
};
describe("task HITL delivery routing", () => {
  beforeEach(() => vi.resetAllMocks());

  it("consumes late task reports from restored cancellation state without suppressing user input", async () => {
    const session = registerWorkflowToolRun(state(false).snapshot.session, {
      callId: "call-1",
      toolName: "worker",
      lifetime: "session",
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "task-run", hookToken: "task-inbox" },
      task: {
        taskId: "task-1",
        metadata: { kind: "subagent", name: "worker" },
        dispatchContext: { auth: { current: null, initiator: null } },
      },
    });
    const cancelled = {
      taskId: "task-1",
      metadata: { kind: "subagent", name: "worker" },
      status: "cancelled" as const,
    };
    const sessionState = createTestSessionState({
      snapshot: {
        session: {
          ...session,
          state: JSON.parse(
            JSON.stringify(
              recordWorkflowTaskView(session.state, cancelled, { notifications: "suppressed" }),
            ),
          ),
        },
      },
    });
    vi.mocked(recordTerminalTaskViewsStep).mockResolvedValue({
      views: [cancelled],
      subagentCompletions: [],
      sessionState,
      serializedContext: {},
    });
    const context = {
      sessionState,
      serializedContext: {},
      sessionWritable: new WritableStream<Uint8Array>(),
    };
    const outcome = await routeDeliverToChildren({
      ...context,
      delivery: {
        kind: "deliver",
        taskDeliveryId: "task-1:ready:completed",
        payloads: [{ message: "Late completion", task: { views: [cancelled] } }],
      },
    });
    expect(recordTerminalTaskViewsStep).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ kind: "continue", remainder: undefined });
    vi.mocked(settleTaskAgentInvocationStep).mockResolvedValue({
      settled: false,
      sessionState,
      serializedContext: {},
    });
    const settlement = await routeDeliverToChildren({
      ...context,
      delivery: {
        kind: "deliver",
        taskDeliveryId: "task-1:agent:run-1:settled",
        payloads: [
          {
            task: {
              agentRequests: [
                {
                  taskId: "task-1",
                  replyTo: "settlement-reply",
                  request: {
                    kind: "agent-settled",
                    result: {
                      callId: "child-call",
                      kind: "subagent-result",
                      origin: "child",
                      subagentName: "worker",
                      output: "",
                      outcome: {
                        kind: "parked",
                        result: { kind: "cancelled" },
                        usageDelta: {
                          inputTokens: 0,
                          outputTokens: 0,
                          cacheReadTokens: 0,
                          cacheWriteTokens: 0,
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(settlement).toMatchObject({ kind: "continue", remainder: undefined });
    expect(resumeHookStep).toHaveBeenCalledWith(
      "settlement-reply",
      { kind: "agent-settled", callId: "child-call" },
      { ifPresent: true },
    );
    const update = await routeDeliverToChildren({
      ...context,
      delivery: {
        kind: "deliver",
        taskDeliveryId: "task-1:update:1",
        payloads: [{ message: "Still working" }],
      },
    });
    expect(update).toMatchObject({ kind: "continue", remainder: undefined });
    const user = await routeDeliverToChildren({
      ...context,
      delivery: {
        kind: "deliver",
        payloads: [{ message: "New request" }],
      },
    });
    expect(user).toMatchObject({
      kind: "continue",
      remainder: { payloads: [{ message: "New request" }] },
    });
  });

  it("commits the task route before emitting and consumes the framework-only delivery", async () => {
    const recordedState = state(true);
    vi.mocked(recordTaskInputRequestStep).mockResolvedValue({
      accepted: true,
      request: taskRequest,
      sessionState: recordedState,
    });
    vi.mocked(emitRecordedTaskInputRequestStep).mockResolvedValue({
      serializedContext: { adapter: "updated" },
      sessionState: recordedState,
    });
    vi.mocked(routeProxiedDeliverStep).mockResolvedValue({
      kind: "continue",
      remainder: undefined,
      serializedContext: { adapter: "updated" },
      sessionState: recordedState,
    });

    const result = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        payloads: [{ task: { inputRequests: [taskRequest] } }],
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(recordTaskInputRequestStep).toHaveBeenCalledOnce();
    expect(recordTaskInputRequestStep).toHaveBeenCalledWith(
      expect.objectContaining({ request: taskRequest }),
    );
    expect(emitRecordedTaskInputRequestStep).toHaveBeenCalledOnce();
    expect(emitRecordedTaskInputRequestStep).toHaveBeenCalledWith(
      expect.objectContaining({ request: taskRequest }),
    );
    expect(vi.mocked(recordTaskInputRequestStep).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(emitRecordedTaskInputRequestStep).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("ignores stale requests coalesced with their task's terminal outcome", async () => {
    vi.mocked(recordTerminalTaskViewsStep).mockResolvedValue({
      subagentCompletions: [],
      views: [],
      serializedContext: {},
      sessionState: state(false),
    });
    await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            task: {
              inputRequests: [taskRequest],
              agentRequests: [
                {
                  replyTo: "agent-reply",
                  taskId: "task-1",
                  request: {
                    kind: "agent-invoke",
                    invocationId: "late-spawn",
                    input: { target: "research", message: "Find it" },
                  },
                },
              ],
              views: [
                {
                  taskId: "task-1",
                  metadata: { kind: "tool", name: "export" },
                  status: "cancelled",
                },
              ],
            },
          },
        ],
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });
    expect(recordTaskInputRequestStep).not.toHaveBeenCalled();
    expect(emitRecordedTaskInputRequestStep).not.toHaveBeenCalled();
    expect(dispatchTaskAgentInvocationStep).not.toHaveBeenCalled();
    expect(recordTerminalTaskViewsStep).toHaveBeenCalledOnce();
  });

  it("uses the parent's cancelled outcome when a late child reports success", async () => {
    const cancelled = {
      taskId: "task-1",
      metadata: { kind: "tool", name: "export" },
      status: "cancelled" as const,
    };
    vi.mocked(recordTerminalTaskViewsStep).mockResolvedValue({
      subagentCompletions: [],
      views: [cancelled],
      serializedContext: {},
      sessionState: state(false),
    });
    const result = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        taskDeliveryId: "task-1:ready:completed",
        payloads: [
          {
            message: "Success!",
            task: {
              views: [
                { ...cancelled, status: "completed", lastOutput: { type: "result", data: "late" } },
              ],
            },
          },
        ],
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });
    expect(result).toMatchObject({
      kind: "continue",
      remainder: { payloads: [{ message: "Background task task-1 (export) is cancelled." }] },
    });
  });

  it("retains every task notification identity after consuming terminal views", async () => {
    const taskDeliveryIds = ["task-1:ready:completed", "task-2:ready:completed"];
    const views = ["task-1", "task-2"].map((taskId) => ({
      taskId,
      status: "completed" as const,
      metadata: { kind: "tool", name: "report" },
      lastOutput: { type: "result" as const, data: taskId },
    }));
    vi.mocked(recordTerminalTaskViewsStep).mockResolvedValue({
      subagentCompletions: [],
      views,
      serializedContext: {},
      sessionState: state(false),
    });
    const result = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        taskDeliveryId: taskDeliveryIds[0],
        taskDeliveryIds,
        payloads: views.map((view) => ({ message: view.taskId, task: { views: [view] } })),
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });
    expect(result).toMatchObject({
      kind: "continue",
      remainder: {
        taskDeliveryId: taskDeliveryIds[0],
        taskDeliveryIds,
        payloads: [
          { message: "Background task task-1 (report) is completed.\n\nResult:\ntask-1" },
          { message: "Background task task-2 (report) is completed.\n\nResult:\ntask-2" },
        ],
      },
    });
    expect(recordTerminalTaskViewsStep).toHaveBeenCalledWith(expect.objectContaining({ views }));
  });

  it("adopts instrumentation context returned with terminal task views", async () => {
    const recordedState = state(false);
    const view = {
      lastOutput: { data: "done", type: "result" as const },
      metadata: { kind: "tool", name: "publish" },
      status: "completed" as const,
      taskId: "task-1",
    };
    vi.mocked(recordTerminalTaskViewsStep).mockResolvedValue({
      subagentCompletions: [],
      views: [view],
      serializedContext: { trace: "settled" },
      sessionState: recordedState,
    });

    const result = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        payloads: [{ task: { views: [view] } }],
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: { trace: "open" },
      sessionState: state(false),
    });

    expect(recordTerminalTaskViewsStep).toHaveBeenCalledWith({
      serializedContext: { trace: "open" },
      sessionState: state(false),
      views: [view],
    });
    expect(result).toEqual({
      kind: "continue",
      remainder: undefined,
      serializedContext: { trace: "settled" },
      sessionState: recordedState,
    });
  });

  it("drops an unowned task envelope before it can reach the parent model", async () => {
    vi.mocked(recordTaskInputRequestStep).mockResolvedValue({
      accepted: false,
      sessionState: state(false),
    });

    const result = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        payloads: [{ task: { inputRequests: [{ ...taskRequest, taskId: "foreign-task" }] } }],
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(emitRecordedTaskInputRequestStep).not.toHaveBeenCalled();
    expect(routeProxiedDeliverStep).not.toHaveBeenCalled();
  });

  it("proxies a task-owned agent authorization event through the parent channel", async () => {
    const nextState = state(false);
    const event = {
      callId: "call-1",
      childSessionId: "child-1",
      event: {
        data: {
          description: "Authorize Linear",
          name: "linear",
          sequence: 1,
          stepIndex: 2,
          turnId: "turn-child",
        },
        type: "authorization.required" as const,
      },
      kind: "subagent-authorization-event" as const,
      subagentName: "research",
    };
    vi.mocked(runProxySubagentEventStep).mockResolvedValue({
      serializedContext: { adapter: "updated" },
      sessionState: nextState,
    });
    vi.mocked(acceptTaskAuthorizationEventStep).mockResolvedValue(true);

    const result = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            task: {
              authorizationEvents: [{ hookPayload: event, taskId: "task-1" }],
            },
          },
        ],
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(acceptTaskAuthorizationEventStep).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: { hookPayload: event, taskId: "task-1" },
      }),
    );
    expect(runProxySubagentEventStep).toHaveBeenCalledWith(
      expect.objectContaining({ hookPayload: event }),
    );
    expect(result).toMatchObject({
      kind: "continue",
      serializedContext: { adapter: "updated" },
      sessionState: nextState,
    });
  });

  it("dispatches agent invocations against the parent state and replies with immediate errors", async () => {
    const nextState = state(false);
    const result = {
      callId: "call-1:research",
      isError: true as const,
      kind: "subagent-result" as const,
      origin: "dispatch" as const,
      output: { code: "AGENT_UNREACHABLE", message: "gone" },
      subagentName: "research",
    };
    vi.mocked(dispatchTaskAgentInvocationStep).mockResolvedValue({
      kind: "failed",
      result,
      sessionState: nextState,
    });

    const routed = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            task: {
              agentRequests: [
                {
                  replyTo: "agent-reply",
                  request: {
                    input: { message: "Find it", target: "research" },
                    invocationId: "call-1:research",
                    kind: "agent-invoke" as const,
                  },
                  taskId: "task-1",
                },
              ],
            },
          },
        ],
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: { source: "parent" },
      sessionState: state(false),
    });

    expect(dispatchTaskAgentInvocationStep).toHaveBeenCalledWith({
      ownerId: "task-1",
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", target: "research" },
        invocationId: "call-1:research",
        kind: "agent-invoke",
      },
      serializedContext: { source: "parent" },
      sessionState: state(false),
      taskId: "task-1",
    });
    expect(resumeHookStep).toHaveBeenCalledWith("agent-reply", {
      kind: "runtime-action-result",
      results: [result],
    });
    expect(acceptTaskAuthorizationEventStep).not.toHaveBeenCalled();
    expect(routed).toMatchObject({ sessionState: nextState });
  });

  it("reindexes ordinary metadata after consuming task-only payloads", async () => {
    const routedState = state(true);
    vi.mocked(routeProxiedDeliverStep).mockResolvedValue({
      kind: "continue",
      remainder: undefined,
      serializedContext: {},
      sessionState: routedState,
    });
    const caller = {
      callId: "call-parent",
      replyTo: { kind: "hook" as const, token: "parent-turn" },
      subagentName: "research",
    };

    await routeDeliverToChildren({
      delivery: {
        caller,
        deliveryMetadata: [
          { channelKind: "test", channelName: "main", deliveryId: "task", payloadIndex: 0 },
          { channelKind: "test", channelName: "main", deliveryId: "ordinary", payloadIndex: 1 },
        ],
        kind: "deliver",
        payloads: [{ task: { views: [] } }, { message: "parent message" }],
        requestId: "request-1",
        taskDeliveryId: "task-delivery-1",
        turnPolicy: "queue",
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: routedState,
    });

    expect(routeProxiedDeliverStep).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: {
          caller,
          deliveryMetadata: [expect.objectContaining({ deliveryId: "ordinary", payloadIndex: 0 })],
          kind: "deliver",
          payloads: [{ message: "parent message" }],
          requestId: "request-1",
          taskDeliveryId: "task-delivery-1",
          turnPolicy: "queue",
        },
      }),
    );
  });
});
